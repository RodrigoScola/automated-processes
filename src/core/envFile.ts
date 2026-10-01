import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'dotenv';

export type EnvMap = Record<string, string>;

export function parseEnvText(text: string): EnvMap {
	return parse(text);
}

/** Reads an env file relative to `root`. Missing file → `undefined`. */
export function readEnvFile(root: string, file: string): EnvMap | undefined {
	const fullPath = path.resolve(root, file);
	let text: string;
	try {
		text = fs.readFileSync(fullPath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
	return parseEnvText(text);
}
