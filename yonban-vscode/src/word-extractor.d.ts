declare module "word-extractor" {
  interface Document {
    getBody(): string;
    getFootnotes(): string;
    getHeaders(): string;
  }
  class WordExtractor {
    extract(filePath: string): Promise<Document>;
  }
  export = WordExtractor;
}
