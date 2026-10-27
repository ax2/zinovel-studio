export function publicationRasterImages(
  resources: readonly Readonly<{
    image: Readonly<{
      sha256: string;
      bytes: number;
      width: number;
      height: number;
    }>;
  }>[],
  input: unknown,
  label?: "DOCX" | "PDF",
): Promise<Map<string, Buffer>>;
