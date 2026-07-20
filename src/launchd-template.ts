export interface LaunchdTemplateValues {
  nodeBin: string;
  repoDir: string;
  envFile: string;
  home: string;
}

export function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchdTemplate(
  template: string,
  values: LaunchdTemplateValues,
): string {
  const rendered = template
    .replaceAll("__NODE_BIN__", escapeXmlText(values.nodeBin))
    .replaceAll("__REPO_DIR__", escapeXmlText(values.repoDir))
    .replaceAll("__ENV_FILE__", escapeXmlText(values.envFile))
    .replaceAll("__HOME__", escapeXmlText(values.home));
  if (/__[A-Z_]+__/.test(rendered)) {
    throw new Error("LaunchAgent template contains an unresolved placeholder");
  }
  return rendered;
}
