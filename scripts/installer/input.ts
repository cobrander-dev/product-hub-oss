export async function readBoundedInput(limit = 8192): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    length += bytes.length;
    if (length > limit) throw new Error("INPUT_LIMIT");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
