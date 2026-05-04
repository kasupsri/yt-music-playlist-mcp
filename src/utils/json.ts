export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function compactError(error: unknown): { message: string; name?: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: process.env.NODE_ENV === "test" ? error.stack : undefined
    };
  }

  return { message: String(error) };
}
