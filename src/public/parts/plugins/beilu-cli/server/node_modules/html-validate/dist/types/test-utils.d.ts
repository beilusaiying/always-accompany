import { Source } from 'html-validate';
import { Transformer as Transformer_2 } from 'html-validate';
import { TransformerChainedResult } from 'html-validate';
import { TransformerResult } from 'html-validate';

export { Source }

export { Transformer_2 as Transformer }

export { TransformerChainedResult }

export { TransformerResult }

/**
 * Helper function to call a transformer function in test-cases.
 *
 * @public
 * @param fn - Transformer function to call.
 * @param filename - Filename to read data from. Must be readable.
 * @param chain - If set this function is called when chaining transformers. Default is pass-thru.
 */
export declare function transformFile(fn: Transformer_2, filename: string, chain?: (source: Source, filename: string) => TransformerChainedResult): Promise<Source[]>;

/**
 * Helper function to call a transformer function in test-cases.
 *
 * @public
 * @param fn - Transformer function to call.
 * @param data - Source to transform.
 * @param chain - If set this function is called when chaining transformers. Default is pass-thru.
 */
export declare function transformSource(fn: Transformer_2, source: Source, chain?: (source: Source, filename: string) => TransformerChainedResult): Promise<Source[]>;

/**
 * Helper function to call a transformer function in test-cases.
 *
 * @public
 * @param fn - Transformer function to call.
 * @param data - String to transform.
 * @param chain - If set this function is called when chaining transformers. Default is pass-thru.
 */
export declare function transformString(fn: Transformer_2, data: string, chain?: (source: Source, filename: string) => TransformerChainedResult): Promise<Source[]>;

export { }
