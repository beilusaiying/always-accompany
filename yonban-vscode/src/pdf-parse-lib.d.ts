declare module "pdf-parse/lib/pdf-parse" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: unknown;
    metadata: unknown;
  }
  function pdf(dataBuffer: Buffer | Uint8Array): Promise<PdfParseResult>;
  export = pdf;
}
