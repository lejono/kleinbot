export function sanitizeFilename(filename: string): string {
  return filename.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").slice(0, 80);
}
