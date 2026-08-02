export declare enum Severity {
	OFF = 0,
	WARN = 1,
	ERROR = 2
}
export interface Message {
	ruleId?: string;
	severity: Severity;
	fatal?: boolean;
	message: string;
	line?: number;
	column?: number;
}
export interface Result {
	messages: Message[];
	filePath: string;
	errorCount: number;
	warningCount: number;
	fixableErrorCount: number;
	fixableWarningCount: number;
}
export declare function stylish(results: Result[]): string;

export {};
