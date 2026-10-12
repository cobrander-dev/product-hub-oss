// Diagnostic data is not application data: deliberately discard request bodies,
// headers, form values, scripts and arbitrary console/error text before export.
export function diagnosticRedactor(values: string[]) {
  const secrets = [...new Set(values.filter((value) => value.length >= 4))]
    .flatMap((value) => [value, encodeURIComponent(value)])
    .sort((a, b) => b.length - a.length);
  return (input: string): string => {
    let text = input;
    for (const secret of secrets) text = text.replaceAll(secret, "[REDACTED]");
    return text
      .replace(/(?:postgres(?:ql)?|mysql):\/\/[^\s"<>]+/gi, "[DATABASE_URL]")
      .replace(/[A-Za-z0-9_+/.=-]{32,}/g, "[OPAQUE_VALUE]");
  };
}

export function environmentSecrets(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.entries(env)
    .filter(
      ([key, value]) =>
        value && /PASSWORD|SECRET|TOKEN|DATABASE_URL/i.test(key),
    )
    .flatMap(([, value]) => {
      const values = [value!];
      try {
        const url = new URL(value!);
        if (url.password) values.push(decodeURIComponent(url.password));
      } catch {
        /* Not a URL. */
      }
      return values;
    });
}

export function diagnosticPath(
  value: string,
  redact: (value: string) => string,
): string {
  try {
    return redact(new URL(value).pathname);
  } catch {
    return "[NON_HTTP_URL]";
  }
}
