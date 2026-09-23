import { z } from "zod";

export const configSchema = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8317),
  codex: z
    .object({
      cloak: z.boolean().default(true),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;

export async function loadConfig(path: string): Promise<Config> {
  const file = Bun.file(path);
  const raw = (await file.exists()) ? (Bun.YAML.parse(await file.text()) ?? {}) : {};
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config in ${path}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
