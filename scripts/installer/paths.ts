import { isAbsolute, resolve } from "node:path";

export function repositoryRoot() {
  const configured = process.env.PRODUCT_HUB_REPOSITORY_ROOT;
  const root = configured
    ? resolve(configured)
    : resolve(import.meta.dirname, "../..");
  if (!isAbsolute(root) || root === "/" || root.includes("\0"))
    throw new Error("INVALID_REPOSITORY_ROOT");
  return root;
}
