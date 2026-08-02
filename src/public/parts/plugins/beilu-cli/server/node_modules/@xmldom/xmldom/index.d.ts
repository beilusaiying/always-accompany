/// <reference lib="dom" />

declare module "@xmldom/xmldom" {
  var DOMParser: DOMParserStatic;
  var XMLSerializer: XMLSerializerStatic;
  var DOMImplementation: DOMImplementationStatic;

  interface DOMImplementationStatic {
      new(): DOMImplementation;
  }

  interface DOMParserStatic {
      new (): DOMParser;
      new (options: Options): DOMParser;
  }

  interface XMLSerializerStatic {
      new (): XMLSerializer;
  }

  interface DOMParser {
      parseFromString(xmlsource: string, mimeType?: string): Document;
  }

  /** Options accepted by `XMLSerializer.prototype.serializeToString`. */
  interface XMLSerializerOptions {
      /**
       * When `true`, the serializer throws a DOMException with code `INVALID_STATE_ERR` if:
       * - A CDATASection node's data contains `"]]>"`.
       * - A Comment node's data contains `"-->"` (the injection sequence that terminates a
       *   comment). Comments whose data contains `"--"` but not `"-->"` are accepted on this
       *   branch — the 0.8.x parser does not validate bare `"--"` in comment content.
       * - A ProcessingInstruction's data contains `"?>"` (W3C DOM Parsing §3.2.1.7).
       *
       * @default false
       */
      requireWellFormed?: boolean;
  }

  interface XMLSerializer {
      /**
       * Returns the result of serializing `node` to XML.
       *
       * When `options.requireWellFormed` is `true`, the serializer throws for content that would
       * produce ill-formed XML.
       *
       * __This implementation differs from the specification:__
       * - CDATASection nodes whose data contains `]]>` are serialized by splitting the section
       *   at each `]]>` occurrence (following W3C DOM Level 3 Core `split-cdata-sections`
       *   default behaviour) unless `requireWellFormed` is `true`.
       * - when `requireWellFormed` is `true`, `DOMException` with code `INVALID_STATE_ERR`
       *   is only thrown to prevent injection vectors, not for all the spec mandated checks.
       *
       * @throws {DOMException}
       * With code `INVALID_STATE_ERR` when `requireWellFormed` is `true` and:
       * - a CDATASection node's data contains `"]]>"`,
       * - a Comment node's data contains `"-->"` (bare `"--"` does not throw on this branch),
       * - a ProcessingInstruction's data contains `"?>"`,
       * - a DocumentType's `publicId` is non-empty and does not match the XML `PubidLiteral`
       *   production,
       * - a DocumentType's `systemId` is non-empty and does not match the XML `SystemLiteral`
       *   production, or
       * - a DocumentType's `internalSubset` contains `"]>"`.
       * Note: xmldom does not enforce `readonly` on DocumentType fields — direct property
       * writes succeed and are covered by the serializer-level checks above.
       * @see https://html.spec.whatwg.org/#dom-xmlserializer-serializetostring
       * @see https://w3c.github.io/DOM-Parsing/#xml-serialization
       * @see https://github.com/w3c/DOM-Parsing/issues/84
       */
      serializeToString(node: Node, isHtml?: boolean, nodeFilter?: (node: Node) => Node | null | undefined, options?: XMLSerializerOptions): string;
  }

  interface Options {
      locator?: any;
      errorHandler?: ErrorHandlerFunction | ErrorHandlerObject | undefined;
  }

  interface ErrorHandlerFunction {
      (level: string, msg: any): any;
  }

  interface ErrorHandlerObject {
      warning?: ((msg: any) => any) | undefined;
      error?: ((msg: any) => any) | undefined;
      fatalError?: ((msg: any) => any) | undefined;
  }
}
