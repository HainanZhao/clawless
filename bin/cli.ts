#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ENV_KEY_MAP: Record<string, string> = {
	telegramToken: 'TELEGRAM_TOKEN',
	typingIntervalMs: 'TYPING_INTERVAL_MS',
	geminiCommand: 'GEMINI_COMMAND',
	geminiApprovalMode: 'GEMINI_APPROVAL_MODE',
	geminiModel: 'GEMINI_MODEL',
	acpPermissionStrategy: 'ACP_PERMISSION_STRATEGY',
	geminiTimeoutMs: 'GEMINI_TIMEOUT_MS',
	geminiNoOutputTimeoutMs: 'GEMINI_NO_OUTPUT_TIMEOUT_MS',
	geminiKillGraceMs: 'GEMINI_KILL_GRACE_MS',
	maxResponseLength: 'MAX_RESPONSE_LENGTH',
	acpStreamStdout: 'ACP_STREAM_STDOUT',
	acpDebugStream: 'ACP_DEBUG_STREAM',
	heartbeatIntervalMs: 'HEARTBEAT_INTERVAL_MS',
	callbackHost: 'CALLBACK_HOST',
	callbackPort: 'CALLBACK_PORT',
	callbackAuthToken: 'CALLBACK_AUTH_TOKEN',
	callbackMaxBodyBytes: 'CALLBACK_MAX_BODY_BYTES',
	agentBridgeHome: 'AGENT_BRIDGE_HOME',
	memoryFilePath: 'MEMORY_FILE_PATH',
	memoryMaxChars: 'MEMORY_MAX_CHARS',
	schedulesFilePath: 'SCHEDULES_FILE_PATH',
};

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.gemini-bridge', 'config.json');
const DEFAULT_AGENT_BRIDGE_HOME = path.join(os.homedir(), '.gemini-bridge');
const DEFAULT_MEMORY_FILE_PATH = path.join(DEFAULT_AGENT_BRIDGE_HOME, 'MEMORY.md');
const DEFAULT_CONFIG_TEMPLATE = {
	telegramToken: 'your_telegram_bot_token_here',
	typingIntervalMs: 4000,
	geminiCommand: 'gemini',
	geminiApprovalMode: 'yolo',
	geminiModel: '',
	acpPermissionStrategy: 'allow_once',
	geminiTimeoutMs: 900000,
	geminiNoOutputTimeoutMs: 60000,
	geminiKillGraceMs: 5000,
	maxResponseLength: 4000,
	acpStreamStdout: false,
	acpDebugStream: false,
	heartbeatIntervalMs: 60000,
	callbackHost: '127.0.0.1',
	callbackPort: 8787,
	callbackAuthToken: '',
	callbackMaxBodyBytes: 65536,
	agentBridgeHome: '~/.gemini-bridge',
	memoryFilePath: '~/.gemini-bridge/MEMORY.md',
	memoryMaxChars: 12000,
	schedulesFilePath: '~/.gemini-bridge/schedules.json',
};

function printHelp() {
	console.log(`gemini-bridge

Usage:
	gemini-bridge [--config <path>]

Options:
	--config <path>   Path to JSON config file (default: ~/.gemini-bridge/config.json)
	-h, --help        Show this help message

Config precedence:
	1) Existing environment variables
	2) Values from config file
`);
}

function parseArgs(argv: string[]) {
	const result = {
		configPath: process.env.GEMINI_BRIDGE_CONFIG || process.env.AGENT_BRIDGE_CONFIG || DEFAULT_CONFIG_PATH,
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];

		if (arg === '-h' || arg === '--help') {
			result.help = true;
			continue;
		}

		if (arg === '--config') {
			const value = argv[index + 1];
			if (!value) {
				throw new Error('--config requires a file path');
			}
			result.configPath = value;
			index += 1;
			continue;
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	return result;
}

function toEnvValue(value: unknown) {
	if (value === null || value === undefined) {
		return undefined;
	}
	if (typeof value === 'string') {
		return value;
	}
	return String(value);
}

function resolveEnvKey(configKey: string) {
	if (configKey in ENV_KEY_MAP) {
		return ENV_KEY_MAP[configKey];
	}

	const looksLikeEnvKey = /^[A-Z0-9_]+$/.test(configKey);
	if (looksLikeEnvKey) {
		return configKey;
	}

	return null;
}

function applyConfigToEnv(configData: Record<string, unknown>) {
	if (!configData || typeof configData !== 'object' || Array.isArray(configData)) {
		throw new Error('Config file must contain a JSON object at the top level');
	}

	for (const [configKey, rawValue] of Object.entries(configData)) {
		const envKey = resolveEnvKey(configKey);
		if (!envKey) {
			continue;
		}

		if (process.env[envKey] !== undefined) {
			continue;
		}

		const envValue = toEnvValue(rawValue);
		if (envValue !== undefined) {
			process.env[envKey] = envValue;
		}
	}
}

function resolveConfigPath(configPath: string) {
	if (!configPath || configPath === '~') {
		return os.homedir();
	}

	if (configPath.startsWith('~/')) {
		return path.join(os.homedir(), configPath.slice(2));
	}

	return path.resolve(process.cwd(), configPath);
}

function ensureConfigFile(configPath: string) {
	const absolutePath = resolveConfigPath(configPath);
	if (fs.existsSync(absolutePath)) {
		return { created: false, path: absolutePath };
	}

	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	fs.writeFileSync(absolutePath, `${JSON.stringify(DEFAULT_CONFIG_TEMPLATE, null, 2)}\n`, 'utf8');
	return { created: true, path: absolutePath };
}

function ensureMemoryFile(memoryFilePath: string) {
	const absolutePath = resolveConfigPath(memoryFilePath);
	if (!fs.existsSync(absolutePath)) {
		fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
		const template = [
			'# Agent Bridge Memory',
			'',
			'This file stores durable memory notes for Agent Bridge.',
			'',
			'## Notes',
			'',
		].join('\n');
		fs.writeFileSync(absolutePath, `${template}\n`, 'utf8');
		return { created: true, path: absolutePath };
	}

	return { created: false, path: absolutePath };
}

function ensureMemoryFromEnv() {
	const configuredHome = process.env.AGENT_BRIDGE_HOME || DEFAULT_AGENT_BRIDGE_HOME;
	const configuredMemoryPath = process.env.MEMORY_FILE_PATH || path.join(configuredHome, 'MEMORY.md');

	if (!process.env.AGENT_BRIDGE_HOME) {
		process.env.AGENT_BRIDGE_HOME = configuredHome;
	}

	if (!process.env.MEMORY_FILE_PATH) {
		process.env.MEMORY_FILE_PATH = configuredMemoryPath;
	}

	return ensureMemoryFile(process.env.MEMORY_FILE_PATH || DEFAULT_MEMORY_FILE_PATH);
}

function logMemoryFileCreation(memoryState: { created: boolean; path: string }) {
	if (memoryState.created) {
		console.log(`[gemini-bridge] Created memory file: ${memoryState.path}`);
	}
}

function loadConfigFile(configPath: string) {
	const absolutePath = resolveConfigPath(configPath);
	if (!fs.existsSync(absolutePath)) {
		return null;
	}

	const fileContent = fs.readFileSync(absolutePath, 'utf8');
	const parsed = JSON.parse(fileContent);
	applyConfigToEnv(parsed);
	return absolutePath;
}

try {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		printHelp();
		process.exit(0);
	}

	const configState = ensureConfigFile(args.configPath);
	const memoryState = ensureMemoryFromEnv();
	logMemoryFileCreation(memoryState);

	if (configState.created) {
		console.log(`[gemini-bridge] Created config template: ${configState.path}`);
		console.log('[gemini-bridge] Fill in placeholder values, then run gemini-bridge again.');
		process.exit(0);
	}

	const loadedConfigPath = loadConfigFile(args.configPath);
	if (loadedConfigPath) {
		console.log(`[gemini-bridge] Loaded config: ${loadedConfigPath}`);
	}

	const postConfigMemoryState = ensureMemoryFromEnv();
	logMemoryFileCreation(postConfigMemoryState);

	await import('../index.js');
} catch (error: any) {
	console.error(`[gemini-bridge] ${error.message}`);
	process.exit(1);
}