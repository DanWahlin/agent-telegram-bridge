{
  "targets": [
    {
      "target_name": "platform_security",
      "sources": ["platform_security.cc"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "GCC_WARN_INHIBIT_ALL_WARNINGS": "NO",
            "WARNING_CFLAGS": ["-Wall", "-Wextra", "-Werror"]
          }
        }]
      ]
    }
  ]
}
