/*
** Copyright (c) 2019 Oracle and/or its affiliates.  All rights reserved.
** Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl.
*/
'use strict';

const TranslationService = require('../services/TranslationService');
const TRANSLATION_KEYS = require('../services/TranslationKeys');
const assert = require('assert');

module.exports = class CommandOptionsValidator {
	validate(options) {
		assert(options);
		assert(options.commandOptions);
		assert(options.arguments);

		const validationErrors = [];

		const isMandatoryOptionPresent = (optionId, aliasId, args) => {
			return args[optionId] || args[aliasId];
		};

		for (const optionId in options.commandOptions) {
			const option = options.commandOptions[optionId];
			const aliasId = option.alias;
			if (options.commandOptions.hasOwnProperty(optionId)) {
				if (
					option.mandatory &&
					!isMandatoryOptionPresent(optionId, aliasId, options.arguments)
				) {
					validationErrors.push(
						TranslationService.getMessage(
							TRANSLATION_KEYS.COMMAND_OPTION_IS_MANDATORY,
							option.name
						)
					);
				}
			}
		}
		return validationErrors;
	}
};
