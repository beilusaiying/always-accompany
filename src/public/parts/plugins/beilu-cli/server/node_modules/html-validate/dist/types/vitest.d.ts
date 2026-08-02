export { }



import { type ConfigData } from "./index"
import { type Message } from "./index"
import "vitest";
declare module "vitest" {
    interface Assertion<T = any> {
        /**
         * @since 8.5.0
         */
        toBeValid(): T;
        /**
         * @since 8.5.0
         */
        toBeInvalid(): T;
        /**
         * @since 8.5.0
         */
        toHaveError(error: Partial<Message>): T;
        /**
         * @since 8.5.0
         */
        toHaveError(ruleId: string, message: string, context?: any): T;
        /**
         * @since 8.5.0
         */
        toHaveErrors(errors: Array<[string, string] | Record<string, unknown>>): T;
        /**
         * Validate string or HTMLElement.
         *
         * Test passes if result is valid.
         *
         * @param config - Optional HTML-Validate configuration object.
         * @param filename - Optional filename used when matching transformer and
         * loading configuration.
         *
         * @since 8.5.0
         */
        toHTMLValidate(filename?: string): T;
        toHTMLValidate(config: ConfigData, filename?: string): T;
        toHTMLValidate(error: Partial<Message>, filename?: string): T;
        toHTMLValidate(error: Partial<Message>, config: ConfigData, filename?: string): T;
    }
}
