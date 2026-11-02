/**
 * The seed template: the 64 milestones of the brief as one straight chain, plus the 7 default project fields.
 * The JSON is hand-written (short, hand-picked keys) and always goes through the same validator as an import.
 */
import seedJson from "./seed/template.v1.json";
import { parseTemplateFile, type TemplateFile } from "./templateFile";

/** The parsed, validated seed. Returns a fresh copy on every call. Throws if the seed file is invalid. */
export function seedTemplateFile(): TemplateFile {
  const result = parseTemplateFile(seedJson as unknown);
  if (!result.ok) {
    throw new Error(`The built-in seed template is invalid:\n- ${result.errors.join("\n- ")}`);
  }
  return result.file;
}
