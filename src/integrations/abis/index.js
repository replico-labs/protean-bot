import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url));

/** ABI fragments for one protocol, extracted from its official build artifacts (see each file's _source). */
export function loadIntegrationAbi(name) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
}
