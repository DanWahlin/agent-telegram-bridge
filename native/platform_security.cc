#include <node_api.h>
#include <stdint.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>

#ifdef __APPLE__
#include <limits.h>
#include <libproc.h>
#include <string.h>
#endif

#include <unordered_map>
#include <vector>

namespace {

std::unordered_map<uint64_t, int> lock_descriptors;
uint64_t next_lock_token = 1;

napi_value Throw(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

bool ReadString(napi_env env, napi_value value, std::vector<char>* output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length == 0) {
    return false;
  }
  output->resize(length + 1);
  size_t written = 0;
  return napi_get_value_string_utf8(env, value, output->data(), output->size(), &written) == napi_ok
    && written == length;
}

napi_value AcquireLock(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) {
    return Throw(env, "platform_security.acquireLock expects one path");
  }

  std::vector<char> path;
  if (!ReadString(env, args[0], &path)) {
    return Throw(env, "platform_security.acquireLock received an invalid path");
  }

  const int fd = open(path.data(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) return Throw(env, "Could not open ownership lock file");

  struct stat opened{};
  if (fstat(fd, &opened) != 0 || !S_ISREG(opened.st_mode)
      || opened.st_nlink != 1 || opened.st_uid != geteuid()) {
    close(fd);
    return Throw(env, "Ownership lock must be a singly linked owner-controlled regular file");
  }
  if (fchmod(fd, 0600) != 0) {
    close(fd);
    return Throw(env, "Could not enforce ownership lock permissions");
  }
  if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    close(fd);
    return Throw(env, "Ownership lock is already held");
  }

  uint64_t token = next_lock_token++;
  if (token == 0) token = next_lock_token++;
  lock_descriptors.emplace(token, fd);
  napi_value result;
  if (napi_create_bigint_uint64(env, token, &result) != napi_ok) {
    flock(fd, LOCK_UN);
    close(fd);
    lock_descriptors.erase(token);
    return Throw(env, "Could not create ownership lock token");
  }
  return result;
}

napi_value ReleaseLock(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) {
    return Throw(env, "platform_security.releaseLock expects one token");
  }
  uint64_t token = 0;
  bool lossless = false;
  if (napi_get_value_bigint_uint64(env, args[0], &token, &lossless) != napi_ok || !lossless) {
    return Throw(env, "platform_security.releaseLock received an invalid token");
  }
  const auto entry = lock_descriptors.find(token);
  if (entry == lock_descriptors.end()) return Throw(env, "Ownership lock token is not active");
  const int fd = entry->second;
  lock_descriptors.erase(entry);
  const int unlock_result = flock(fd, LOCK_UN);
  const int close_result = close(fd);
  if (unlock_result != 0 || close_result != 0) {
    return Throw(env, "Could not release ownership lock");
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

#ifdef __APPLE__
struct ProcessIdentity {
  uint64_t start_seconds;
  uint64_t start_microseconds;
  uint64_t cwd_dev;
  uint64_t cwd_ino;
};

bool ReadBsdInfo(pid_t pid, struct proc_bsdinfo* info) {
  memset(info, 0, sizeof(*info));
  const int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, static_cast<int>(sizeof(*info)));
  return size == static_cast<int>(sizeof(*info));
}

bool InspectProcess(pid_t pid, ProcessIdentity* identity) {
  struct proc_bsdinfo before;
  struct proc_bsdinfo after;
  struct proc_vnodepathinfo vnode;
  if (!ReadBsdInfo(pid, &before)) return false;
  memset(&vnode, 0, sizeof(vnode));
  const int vnode_size = proc_pidinfo(
    pid, PROC_PIDVNODEPATHINFO, 0, &vnode, static_cast<int>(sizeof(vnode))
  );
  if (vnode_size != static_cast<int>(sizeof(vnode)) || !ReadBsdInfo(pid, &after)) return false;
  if (before.pbi_start_tvsec != after.pbi_start_tvsec
      || before.pbi_start_tvusec != after.pbi_start_tvusec) return false;
  const struct vinfo_stat* cwd = &vnode.pvi_cdir.vip_vi.vi_stat;
  identity->start_seconds = before.pbi_start_tvsec;
  identity->start_microseconds = before.pbi_start_tvusec;
  identity->cwd_dev = cwd->vst_dev;
  identity->cwd_ino = cwd->vst_ino;
  return true;
}

bool SetBigInt(napi_env env, napi_value object, const char* name, uint64_t value) {
  napi_value result;
  return napi_create_bigint_uint64(env, value, &result) == napi_ok
    && napi_set_named_property(env, object, name, result) == napi_ok;
}
#endif

napi_value Inspect(napi_env env, napi_callback_info info) {
#ifndef __APPLE__
  return Throw(env, "Darwin process inspection is unavailable on this platform");
#else
  size_t argc = 1;
  napi_value args[1];
  if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc != 1) {
    return Throw(env, "platform_security.inspect expects one PID");
  }
  int64_t parsed_pid = 0;
  if (napi_get_value_int64(env, args[0], &parsed_pid) != napi_ok
      || parsed_pid <= 0 || parsed_pid > INT_MAX) {
    return Throw(env, "platform_security.inspect received an invalid PID");
  }
  ProcessIdentity identity{};
  if (!InspectProcess(static_cast<pid_t>(parsed_pid), &identity)) {
    return Throw(env, "Darwin process identity inspection failed");
  }
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok
      || !SetBigInt(env, result, "startSeconds", identity.start_seconds)
      || !SetBigInt(env, result, "startMicroseconds", identity.start_microseconds)
      || !SetBigInt(env, result, "cwdDev", identity.cwd_dev)
      || !SetBigInt(env, result, "cwdIno", identity.cwd_ino)) {
    return Throw(env, "Could not construct Darwin process identity result");
  }
  return result;
#endif
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"acquireLock", nullptr, AcquireLock, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"releaseLock", nullptr, ReleaseLock, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspect", nullptr, Inspect, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, 3, properties) != napi_ok) {
    return Throw(env, "Could not initialize platform security addon");
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
