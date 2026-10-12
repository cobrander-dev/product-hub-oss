import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  ConfigFailure,
  loadProductionConfig,
  validateImageReference,
  writeManifestReleaseFiles,
  writeReleaseFiles,
} from "./config";
import {
  parseReleaseManifest,
  ReleaseManifestFailure,
} from "../release/manifest";
import { verifyLocalReleaseImages } from "../release/verify-manifest";

const command = process.argv[2];
const args = process.argv.slice(3);

function imageFlag(name: string) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1]!.startsWith("--"))
    throw new ConfigFailure(
      `MISSING_${name.slice(2).toUpperCase().replaceAll("-", "_")}`,
    );
  return args[index + 1]!;
}

function validateArguments() {
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--force") {
      if (seen.has(argument)) throw new ConfigFailure("DUPLICATE_ARGUMENT");
      seen.add(argument);
      continue;
    }
    if (
      ![
        "--runner-image",
        "--migrator-image",
        "--worker-image",
        "--manifest",
      ].includes(argument)
    )
      throw new ConfigFailure("UNEXPECTED_ARGUMENT");
    if (
      seen.has(argument) ||
      !args[index + 1] ||
      args[index + 1]!.startsWith("--")
    )
      throw new ConfigFailure("INVALID_ARGUMENT");
    seen.add(argument);
    index++;
  }
}

try {
  if (command !== "preflight" && command !== "configure")
    throw new ConfigFailure("INVALID_COMMAND");
  const inputFile =
    process.env.PRODUCT_HUB_ENV_FILE ||
    "/opt/product-hub/config/product-hub.env";
  const config = loadProductionConfig(inputFile);
  if (command === "preflight") {
    if (args.length) throw new ConfigFailure("UNEXPECTED_ARGUMENT");
    process.stdout.write(
      "PASS: production configuration and filesystem preflight\n",
    );
  } else {
    validateArguments();
    const manifestIndex = args.indexOf("--manifest");
    if (manifestIndex >= 0) {
      if (
        args.some((value) =>
          ["--runner-image", "--migrator-image", "--worker-image"].includes(
            value,
          ),
        )
      )
        throw new ConfigFailure("CONFLICTING_RELEASE_INPUT");
      const manifestPath = args[manifestIndex + 1]!;
      const manifest = parseReleaseManifest(readFileSync(manifestPath, "utf8"));
      verifyLocalReleaseImages(manifest);
      const template = readFileSync(
        join(
          import.meta.dirname,
          "../../deploy/templates/compose.manifest.yaml.template",
        ),
        "utf8",
      );
      writeManifestReleaseFiles(
        config,
        manifest,
        template,
        args.includes("--force"),
      );
      process.stdout.write(
        "PASS: generated digest-pinned release override and restricted runtime env\n",
      );
    } else {
      const images = {
        runner: validateImageReference(imageFlag("--runner-image")),
        migrator: validateImageReference(imageFlag("--migrator-image")),
        worker: validateImageReference(imageFlag("--worker-image")),
      };
      const architecture = spawnSync(
        "sh",
        [
          join(
            import.meta.dirname,
            "../verify-production-image-architecture.sh",
          ),
          images.runner,
          images.migrator,
          images.worker,
        ],
        { encoding: "utf8" },
      );
      if (architecture.status !== 0)
        throw new ConfigFailure("IMAGE_ARCHITECTURE");
      const template = readFileSync(
        join(
          import.meta.dirname,
          "../../deploy/templates/compose.release.yaml.template",
        ),
        "utf8",
      );
      writeReleaseFiles(config, images, template, args.includes("--force"));
      process.stdout.write(
        "PASS: generated release override and restricted runtime env\n",
      );
    }
  }
} catch (error) {
  process.stderr.write(
    `FAIL: ${error instanceof ConfigFailure || error instanceof ReleaseManifestFailure ? error.code : "INTERNAL_ERROR"}\n`,
  );
  process.exitCode = 1;
}
