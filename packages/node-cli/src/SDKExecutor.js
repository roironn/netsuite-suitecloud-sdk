/*
 ** Copyright (c) 2020 Oracle and/or its affiliates.  All rights reserved.
 ** Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl.
 */
'use strict';

const {
	SDK_INTEGRATION_MODE_JVM_OPTION,
	SDK_CLIENT_PLATFORM_VERSION_JVM_OPTION,
	SDK_PROXY_JVM_OPTIONS,
	FOLDERS,
	SDK_REQUIRED_JAVA_VERSION,
} = require('./ApplicationConstants');
const SDKProperties = require('./core/sdksetup/SDKProperties');
const path = require('path');
const FileUtils = require('./utils/FileUtils');
const spawn = require('child_process').spawn;
const CLISettingsService = require('./services/settings/CLISettingsService');
const EnvironmentInformationService = require('./services/EnvironmentInformationService');
const url = require('url');
const TranslationService = require('./services/TranslationService');
const { ERRORS } = require('./services/TranslationKeys');
const SDKErrorCodes = require('./SDKErrorCodes');
const os = require('os');
const { unlinkSync, writeFileSync } = require('fs');

const HOME_PATH = os.homedir();
const DATA_EVENT = 'data';
const CLOSE_EVENT = 'close';
const UTF8 = 'utf8';

const isWin = process.platform === 'win32'; // taken from https://stackoverflow.com/questions/8683895/how-do-i-determine-the-current-operating-system-with-node-js
const echoOffCommand = '@echo off'; // to avoid echoing the commands in the .bat file

module.exports.SDKExecutor = class SDKExecutor {
	constructor(authenticationService) {
		this._CLISettingsService = new CLISettingsService();
		this._authenticationService = authenticationService;
		this._environmentInformationService = new EnvironmentInformationService();
	}

	execute(executionContext) {
		const proxyOptions = this._getProxyOptions();
		const authId = executionContext.includeProjectDefaultAuthId
			? this._authenticationService.getProjectDefaultAuthId()
			: null;

		return new Promise((resolve, reject) => {
			let lastSdkOutput = '';
			let lastSdkError = '';

			if (!this._CLISettingsService.isJavaVersionValid()) {
				const javaVersionError = this._checkIfJavaVersionIssue();
				if (javaVersionError) {
					reject(javaVersionError);
					return;
				}
			}

			if (executionContext.includeProjectDefaultAuthId) {
				executionContext.addParam('authId', authId);
			}

			const cliParams = this._convertParamsObjToString(
				executionContext.getParams(),
				executionContext.getFlags()
			);

			const integrationModeOption = executionContext.isIntegrationMode()
				? SDK_INTEGRATION_MODE_JVM_OPTION
				: '';

			const clientPlatformVersionOption = `${SDK_CLIENT_PLATFORM_VERSION_JVM_OPTION}=${process.versions.node}`;

			const sdkJarPath = path.join(
				HOME_PATH,
				`${FOLDERS.SUITECLOUD_SDK}/${SDKProperties.getSDKFileName()}`
			);
			if (!FileUtils.exists(sdkJarPath)) {
				throw TranslationService.getMessage(
					ERRORS.SDKEXECUTOR.NO_JAR_FILE_FOUND,
					path.join(__dirname, '..')
				);
			}
			const quotedSdkJarPath = `"${sdkJarPath}"`;
			
			const vmOptions = `${proxyOptions} ${integrationModeOption} ${clientPlatformVersionOption}`;
			const jvmCommand = `java -jar ${vmOptions} ${quotedSdkJarPath} ${executionContext.getCommand()} ${cliParams}`;

			const useScriptCommand = isWin && jvmCommand.length > 2000; //https://support.microsoft.com/en-us/help/830473/command-prompt-cmd-exe-command-line-string-limitation
			const command = useScriptCommand
				? `${os.tmpdir()}${path.sep}sdf_command_${String(Date.now())}.bat`
				: jvmCommand;
			if (useScriptCommand) {
				writeFileSync(command, `${echoOffCommand}\n${jvmCommand}`);
			}
			const childProcess = spawn(command, [], { shell: true });

			childProcess.stderr.on(DATA_EVENT, data => {
				lastSdkError += data.toString(UTF8);
			});

			childProcess.stdout.on(DATA_EVENT, data => {
				lastSdkOutput += data.toString(UTF8);
			});

			childProcess.on(CLOSE_EVENT, code => {
				if (useScriptCommand) {
					unlinkSync(command)
				}
				if (code === 0) {
					try {
						const output = executionContext.isIntegrationMode()
							? JSON.parse(lastSdkOutput)
							: lastSdkOutput;
						if (
							executionContext.isIntegrationMode &&
							output.errorCode &&
							output.errorCode === SDKErrorCodes.NO_TBA_SET_FOR_ACCOUNT
						) {
							reject(
								TranslationService.getMessage(
									ERRORS.SDKEXECUTOR.NO_TBA_FOR_ACCOUNT_AND_ROLE
								)
							);
						}
						resolve(output);
					} catch (error) {
						reject(
							TranslationService.getMessage(ERRORS.SDKEXECUTOR.RUNNING_COMMAND, error)
						);
					}
				} else if (code !== 0) {
					// check if the problem was due to bad Java Version
					const javaVersionError = this._checkIfJavaVersionIssue();

					const sdkErrorMessage = TranslationService.getMessage(
						ERRORS.SDKEXECUTOR.SDK_ERROR,
						code,
						lastSdkError
					);

					reject(javaVersionError ? javaVersionError : sdkErrorMessage);
				}
			});
		});
	}

	_getProxyOptions() {
		if (!this._CLISettingsService.useProxy()) {
			return '';
		}
		const proxyUrl = url.parse(this._CLISettingsService.getProxyUrl());
		if (!proxyUrl.protocol || !proxyUrl.port || !proxyUrl.hostname) {
			throw TranslationService.getMessage(ERRORS.WRONG_PROXY_SETTING, cliSettings.proxyUrl);
		}
		const protocolWithoutColon = proxyUrl.protocol.slice(0, -1);
		const hostName = proxyUrl.hostname;
		const port = proxyUrl.port;
		const { PROTOCOL, HOST, PORT } = SDK_PROXY_JVM_OPTIONS;

		return `${PROTOCOL}=${protocolWithoutColon} ${HOST}=${hostName} ${PORT}=${port}`;
	}

	_convertParamsObjToString(cliParams, flags) {
		let cliParamsAsString = '';
		for (const param in cliParams) {
			if (cliParams.hasOwnProperty(param)) {
				const value = cliParams[param] ? ` ${cliParams[param]} ` : ' ';
				cliParamsAsString += param + value;
			}
		}

		if (flags && Array.isArray(flags)) {
			flags.forEach(flag => {
				cliParamsAsString += ` ${flag} `;
			});
		}

		return cliParamsAsString;
	}

	_checkIfJavaVersionIssue() {
		const javaVersionInstalled = this._environmentInformationService.getInstalledJavaVersionString();
		if (javaVersionInstalled.startsWith(SDK_REQUIRED_JAVA_VERSION)) {
			this._CLISettingsService.setJavaVersionValid(true);
			return;
		}

		this._CLISettingsService.setJavaVersionValid(false);
		if (javaVersionInstalled === '') {
			return TranslationService.getMessage(
				ERRORS.CLI_SDK_JAVA_VERSION_NOT_INSTALLED,
				SDK_REQUIRED_JAVA_VERSION
			);
		}
		return TranslationService.getMessage(
			ERRORS.CLI_SDK_JAVA_VERSION_NOT_COMPATIBLE,
			javaVersionInstalled,
			SDK_REQUIRED_JAVA_VERSION
		);
	}
};
