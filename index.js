/**
 * Token Usage Tracker Extension for SillyTavern
 * Tracks input/output token usage across messages with time-based aggregation
 *
 * Uses SillyTavern's native tokenizer system for accurate counting:
 * - getTokenCountAsync() for async token counting
 * - getTextTokens() for getting actual token IDs when available
 * - Respects user's tokenizer settings (BEST_MATCH, model-specific, etc.)
 */

import { eventSource, event_types, main_api, streamingProcessor, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getTokenCountAsync, getTextTokens, getFriendlyTokenizerName, tokenizers } from '../../../tokenizers.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { getChatCompletionModel, oai_settings } from '../../../openai.js';
import { textgenerationwebui_settings as textgen_settings } from '../../../textgen-settings.js';
import { POPUP_TYPE, Popup } from '../../../popup.js';

const extensionName = 'st-tokenusage';

const defaultSettings = {
    showInTopBar: true,
    compactMode: false,
    showCostEstimates: true,
    defaultChartRange: 30,
    chartHeight: 320,
    enableHourlyTracking: true,
    enableChatTracking: true,
    warningThreshold: 0,
    budgetLimit: 0,
    modelColors: {}, // { "gpt-4o": "#6366f1", "claude-3-opus": "#8b5cf6", ... }
    // Prices per 1M tokens: { "gpt-4o": { in: 2.5, out: 10 }, ... }
    modelPrices: {},
    // Accumulated usage data
    usage: {
        allTime: { input: 0, output: 0, total: 0, messageCount: 0 },
        // Time-based buckets: { "2025-01-15": { input: X, output: Y, total: Z, models: { "gpt-4o": 500, ... } }, ... }
        byDay: {},
        byHour: {},    // "2025-01-15T14": { ... }
        byWeek: {},    // "2025-W03": { ... }
        byMonth: {},   // "2025-01": { ... }
        // Per-chat usage: { "chatId": { input: X, output: Y, ... }, ... }
        byChat: {},
        // Per-model usage: { "gpt-4o": { input: X, output: Y, total: Z, messageCount: N }, ... }
        byModel: {},
    },
};

/**
 * Load extension settings, merging with defaults
 */
function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = structuredClone(defaultSettings);
    }

    // Deep merge defaults for any missing keys
    const settings = extension_settings[extensionName];
    if (!settings.modelColors) settings.modelColors = {};
    if (!settings.usage) settings.usage = structuredClone(defaultSettings.usage);
    if (!settings.usage.allTime) settings.usage.allTime = structuredClone(defaultSettings.usage.allTime);
    if (!settings.usage.byDay) settings.usage.byDay = {};
    if (!settings.usage.byHour) settings.usage.byHour = {};
    if (!settings.usage.byWeek) settings.usage.byWeek = {};
    if (!settings.usage.byMonth) settings.usage.byMonth = {};
    if (!settings.usage.byChat) settings.usage.byChat = {};
    if (!settings.usage.byModel) settings.usage.byModel = {};

    // Initialize modelPrices
    if (!settings.modelPrices) settings.modelPrices = {};

    // Initialize settings with defaults
    if (settings.compactMode === undefined) settings.compactMode = defaultSettings.compactMode;
    if (settings.showCostEstimates === undefined) settings.showCostEstimates = defaultSettings.showCostEstimates;
    if (settings.defaultChartRange === undefined) settings.defaultChartRange = defaultSettings.defaultChartRange;
    if (settings.chartHeight === undefined) settings.chartHeight = defaultSettings.chartHeight;
    if (settings.enableHourlyTracking === undefined) settings.enableHourlyTracking = defaultSettings.enableHourlyTracking;
    if (settings.enableChatTracking === undefined) settings.enableChatTracking = defaultSettings.enableChatTracking;
    if (settings.warningThreshold === undefined) settings.warningThreshold = defaultSettings.warningThreshold;
    if (settings.budgetLimit === undefined) settings.budgetLimit = defaultSettings.budgetLimit;

    // Migration: Convert byDay.models from numeric format to object format
    // Old: models[modelId] = totalTokens (number)
    // New: models[modelId] = { input, output, total }
    for (const dayData of Object.values(settings.usage.byDay)) {
        if (dayData.models) {
            for (const [modelId, value] of Object.entries(dayData.models)) {
                if (typeof value === 'number') {
                    // Migrate: estimate input/output using day's ratio
                    const ratio = dayData.total ? value / dayData.total : 0;
                    dayData.models[modelId] = {
                        input: Math.round((dayData.input || 0) * ratio),
                        output: Math.round((dayData.output || 0) * ratio),
                        total: value
                    };
                }
            }
        }
    }

    return settings;
}

/**
 * Save settings with debounce
 */
function saveSettings() {
    saveSettingsDebounced();
}

/**
 * Get current settings
 */
function getSettings() {
    return extension_settings[extensionName];
}

/**
 * Get the current day key (YYYY-MM-DD)
 */
function getDayKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Get the current hour key (YYYY-MM-DDTHH)
 */
function getHourKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}`;
}

/**
 * Get the current week key (YYYY-WNN)
 */
function getWeekKey(date = new Date()) {
    const year = date.getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const days = Math.floor((date.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
    const weekNumber = Math.ceil((days + startOfYear.getDay() + 1) / 7);
    return `${year}-W${String(weekNumber).padStart(2, '0')}`;
}

/**
 * Get the current month key (YYYY-MM)
 */
function getMonthKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

/**
 * Count tokens using SillyTavern's native tokenizer
 * Uses getTextTokens for accurate IDs when available, falls back to getTokenCountAsync
 * @param {string} text - Text to tokenize
 * @returns {Promise<number>} Token count
 */
async function countTokens(text) {
    if (!text || typeof text !== 'string') return 0;

    try {
        // Get the current tokenizer based on user settings and API
        const { tokenizerId } = getFriendlyTokenizerName(main_api);

        // Try to get actual token IDs first (more accurate)
        const tokenizerType = main_api === 'openai' ? tokenizers.OPENAI : tokenizerId;
        const tokenIds = getTextTokens(tokenizerType, text);

        if (Array.isArray(tokenIds) && tokenIds.length > 0) {
            return tokenIds.length;
        }

        // Fall back to async count (uses caching)
        return await getTokenCountAsync(text);
    } catch (error) {
        console.error('[Token Usage Tracker] Error counting tokens:', error);
        // Ultimate fallback: character-based estimate
        return Math.ceil(text.length / 3.35);
    }
}

/**
 * Get the current model ID based on the active API
 * @returns {string} Model identifier
 */
function getCurrentModelId() {
    try {
        if (main_api === 'openai') {
            const model = getChatCompletionModel();
            return model || oai_settings?.custom_model || 'unknown-openai';
        }
        if (main_api === 'textgenerationwebui') {
            return textgen_settings?.model || 'unknown-textgen';
        }
        if (main_api === 'novel') {
            return 'novelai';
        }
        if (main_api === 'kobold') {
            return 'kobold';
        }
        return main_api || 'unknown';
    } catch (e) {
        console.warn('[Token Usage Tracker] Error getting model ID:', e);
        return 'unknown';
    }
}

/**
 * Record token usage into all relevant buckets
 * @param {number} inputTokens - Tokens in the user message
 * @param {number} outputTokens - Tokens in the AI response
 * @param {string} [chatId] - Optional chat ID for per-chat tracking
 * @param {string} [modelId] - Optional model ID for per-model tracking
 */
function recordUsage(inputTokens, outputTokens, chatId = null, modelId = null) {
    const settings = getSettings();
    const usage = settings.usage;
    const now = new Date();
    const totalTokens = inputTokens + outputTokens;

    const addTokens = (bucket) => {
        bucket.input = (bucket.input || 0) + inputTokens;
        bucket.output = (bucket.output || 0) + outputTokens;
        bucket.total = (bucket.total || 0) + totalTokens;
        bucket.messageCount = (bucket.messageCount || 0) + 1;
    };

    // All-time
    addTokens(usage.allTime);

    // By day
    const dayKey = getDayKey(now);
    if (!usage.byDay[dayKey]) usage.byDay[dayKey] = { input: 0, output: 0, total: 0, messageCount: 0, models: {} };
    addTokens(usage.byDay[dayKey]);

    // Track model within day for stacked chart (with input/output breakdown for cost calculation)
    if (modelId) {
        if (!usage.byDay[dayKey].models) usage.byDay[dayKey].models = {};
        if (!usage.byDay[dayKey].models[modelId]) {
            usage.byDay[dayKey].models[modelId] = { input: 0, output: 0, total: 0 };
        }
        const modelData = usage.byDay[dayKey].models[modelId];
        modelData.input += inputTokens;
        modelData.output += outputTokens;
        modelData.total += totalTokens;
    }

    // By hour
    const hourKey = getHourKey(now);
    if (!usage.byHour[hourKey]) usage.byHour[hourKey] = { input: 0, output: 0, total: 0, messageCount: 0 };
    addTokens(usage.byHour[hourKey]);

    // By week
    const weekKey = getWeekKey(now);
    if (!usage.byWeek[weekKey]) usage.byWeek[weekKey] = { input: 0, output: 0, total: 0, messageCount: 0 };
    addTokens(usage.byWeek[weekKey]);

    // By month
    const monthKey = getMonthKey(now);
    if (!usage.byMonth[monthKey]) usage.byMonth[monthKey] = { input: 0, output: 0, total: 0, messageCount: 0 };
    addTokens(usage.byMonth[monthKey]);

    // By chat
    if (chatId) {
        if (!usage.byChat[chatId]) usage.byChat[chatId] = { input: 0, output: 0, total: 0, messageCount: 0 };
        addTokens(usage.byChat[chatId]);
    }

    // By model (aggregate)
    if (modelId) {
        if (!usage.byModel[modelId]) usage.byModel[modelId] = { input: 0, output: 0, total: 0, messageCount: 0 };
        addTokens(usage.byModel[modelId]);
    }

    saveSettings();

    // Emit custom event for UI updates
    eventSource.emit('tokenUsageUpdated', getUsageStats());

    // Check for warnings/alerts
    checkWarnings();

    console.log(`[Token Usage Tracker] Recorded: +${inputTokens} input, +${outputTokens} output, model: ${modelId || 'unknown'} (using ${getFriendlyTokenizerName(main_api).tokenizerName})`);
}

/**
 * Reset all usage data
 */
function resetAllUsage() {
    const settings = getSettings();
    settings.usage = structuredClone(defaultSettings.usage);
    saveSettings();
    eventSource.emit('tokenUsageUpdated', getUsageStats());
    console.log('[Token Usage Tracker] All usage data reset');
}

/**
 * Get comprehensive usage statistics
 * @returns {Object} Usage statistics object
 */
function getUsageStats() {
    const settings = getSettings();
    const usage = settings.usage;
    const now = new Date();

    // Get current tokenizer info for display
    let tokenizerInfo = { tokenizerName: 'Unknown' };
    try {
        tokenizerInfo = getFriendlyTokenizerName(main_api);
    } catch (e) {
        // Ignore if not available yet
    }

    return {
        allTime: { ...usage.allTime },
        today: usage.byDay[getDayKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0, models: {} },
        thisHour: usage.byHour[getHourKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0 },
        thisWeek: usage.byWeek[getWeekKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0 },
        thisMonth: usage.byMonth[getMonthKey(now)] || { input: 0, output: 0, total: 0, messageCount: 0 },
        currentChat: null, // Will be populated if context available
        // Metadata
        tokenizer: tokenizerInfo.tokenizerName,
        // Raw data for advanced aggregation
        byDay: { ...usage.byDay },
        byHour: { ...usage.byHour },
        byWeek: { ...usage.byWeek },
        byMonth: { ...usage.byMonth },
        byChat: { ...usage.byChat },
        byModel: { ...usage.byModel },
    };
}

/**
 * Get usage for a specific time range
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Object} Aggregated usage for the range
 */
function getUsageForRange(startDate, endDate) {
    const settings = getSettings();
    const usage = settings.usage;

    const result = { input: 0, output: 0, total: 0, messageCount: 0 };

    for (const [day, data] of Object.entries(usage.byDay)) {
        if (day >= startDate && day <= endDate) {
            result.input += data.input || 0;
            result.output += data.output || 0;
            result.total += data.total || 0;
            result.messageCount += data.messageCount || 0;
        }
    }

    return result;
}

/**
 * Get usage for a specific chat
 * @param {string} chatId - Chat ID
 * @returns {Object} Usage for the chat
 */
function getChatUsage(chatId) {
    const settings = getSettings();
    return settings.usage.byChat[chatId] || { input: 0, output: 0, total: 0, messageCount: 0 };
}


/** @type {Promise<number>|null} Promise that resolves to input token count - started early, awaited later */
let pendingInputTokensPromise = null;
let pendingModelId = null;
// For 'continue' type generations, track the pre-continue token count so we can compute the delta
let preContinueTokenCount = 0;

/**
 * Count input tokens from the full prompt context (async helper)
 * @param {object} generate_data - The generation data containing the full prompt
 * @returns {Promise<number>} Total input token count
 */
async function countInputTokens(generate_data) {
    let inputTokens = 0;

    if (generate_data.prompt) {
        // For text completion APIs (kobold, novel, textgen) - prompt is a string
        if (typeof generate_data.prompt === 'string') {
            inputTokens = await countTokens(generate_data.prompt);
        }
        // For chat completion APIs (OpenAI) - prompt is an array of messages
        else if (Array.isArray(generate_data.prompt)) {
            for (const message of generate_data.prompt) {
                if (message.content) {
                    // Content can be a string or an array of content parts (for multimodal)
                    if (typeof message.content === 'string') {
                        inputTokens += await countTokens(message.content);
                    } else if (Array.isArray(message.content)) {
                        // Handle multimodal content (text + images)
                        for (const part of message.content) {
                            if (part.type === 'text' && part.text) {
                                inputTokens += await countTokens(part.text);
                            }
                            if (part.type === 'image_url' || part.type === 'image') {
                                // Estimate image tokens since we can't be precise without knowing the exact model arithmetic
                                // 765 tokens is the cost of a 1024x1024 image in OpenAI high detail mode
                                inputTokens += 765;
                            }
                        }
                    }
                }
                // Count role tokens (~1 token per role)
                if (message.role) {
                    inputTokens += 1;
                }
                // Count name field tokens (used in function calls, tool results, etc.)
                if (message.name) {
                    inputTokens += await countTokens(message.name);
                }
                // Count tool_calls tokens (Standard OpenAI)
                if (Array.isArray(message.tool_calls)) {
                    for (const toolCall of message.tool_calls) {
                        if (toolCall.function) {
                            if (toolCall.function.name) {
                                inputTokens += await countTokens(toolCall.function.name);
                            }
                            if (toolCall.function.arguments) {
                                inputTokens += await countTokens(toolCall.function.arguments);
                            }
                        }
                    }
                }
                // Count invocations tokens (SillyTavern internal)
                if (Array.isArray(message.invocations)) {
                    for (const invocation of message.invocations) {
                        if (invocation.function) {
                            if (invocation.function.name) {
                                inputTokens += await countTokens(invocation.function.name);
                            }
                            if (invocation.function.arguments) {
                                inputTokens += await countTokens(invocation.function.arguments);
                            }
                        }
                    }
                }
                // Count deprecated function_call tokens
                if (message.function_call) {
                    if (message.function_call.name) {
                        inputTokens += await countTokens(message.function_call.name);
                    }
                    if (message.function_call.arguments) {
                        inputTokens += await countTokens(message.function_call.arguments);
                    }
                }
            }
            // Add overhead for message formatting (rough estimate: ~3 tokens per message boundary)
            inputTokens += generate_data.prompt.length * 3;
        }
    }

    return inputTokens;
}

/**
 * Handle GENERATE_AFTER_DATA event - start counting input tokens (non-blocking)
 * @param {object} generate_data - The generation data containing the full prompt
 * @param {boolean} dryRun - Whether this is a dry run (token counting only)
 */
function handleGenerateAfterData(generate_data, dryRun) {
    // Don't count dry runs - they're just for token estimation, not actual API calls
    if (dryRun) return;

    // Capture model ID synchronously (fast)
    pendingModelId = getCurrentModelId();

    // Start token counting but DON'T await - let it run in parallel with the API request
    pendingInputTokensPromise = countInputTokens(generate_data)
        .then(count => {
            console.log(`[Token Usage Tracker] Input tokens (full context): ${count}, model: ${pendingModelId}`);
            return count;
        })
        .catch(error => {
            console.error('[Token Usage Tracker] Error counting input tokens:', error);
            return 0;
        });
}

/**
 * Handle GENERATION_STARTED event - capture pre-continue state
 * This fires before the API call, allowing us to snapshot the current message state
 * for 'continue' type generations so we can calculate the delta later.
 * @param {string} type - Generation type: 'normal', 'continue', 'swipe', 'regenerate', 'quiet', etc.
 * @param {object} params - Generation parameters
 * @param {boolean} isDryRun - Whether this is a dry run
 */
let isQuietGeneration = false;
let isImpersonateGeneration = false;

async function handleGenerationStarted(type, params, isDryRun) {
    if (isDryRun) return;

    // Track the generation type for special handling
    isQuietGeneration = (type === 'quiet');
    isImpersonateGeneration = (type === 'impersonate');

    // Reset pre-continue state
    preContinueTokenCount = 0;

    // For continue type, capture the current message's token count
    if (type === 'continue') {
        try {
            const context = getContext();
            const lastMessage = context.chat[context.chat.length - 1];

            if (lastMessage) {
                // Use existing token count if available
                if (lastMessage.extra?.token_count && typeof lastMessage.extra.token_count === 'number') {
                    preContinueTokenCount = lastMessage.extra.token_count;
                } else {
                    // Calculate it ourselves
                    let tokens = await countTokens(lastMessage.mes || '');
                    if (lastMessage.extra?.reasoning) {
                        tokens += await countTokens(lastMessage.extra.reasoning);
                    }
                    preContinueTokenCount = tokens;
                }
            }
        } catch (error) {
            console.error('[Token Usage Tracker] Error capturing pre-continue state:', error);
            preContinueTokenCount = 0;
        }
    }
}

/**
 * Handle message received event - count output tokens and record
 * Uses SillyTavern's pre-calculated token_count when available (includes reasoning)
 * Falls back to manual counting if not available
 *
 * @param {number} messageIndex - Index of the message in the chat array
 * @param {string} type - Type of message event: 'normal', 'swipe', 'continue', 'command', 'first_message', 'extension', etc.
 */
async function handleMessageReceived(messageIndex, type) {
    // Filter out events that don't correspond to actual API calls
    // These events are emitted for messages created without calling the API
    const nonApiTypes = ['command', 'first_message'];
    if (nonApiTypes.includes(type)) {
        console.log(`[Token Usage Tracker] Skipping non-API message type: ${type}`);
        return;
    }

    // If there's no pending token counting promise, this likely isn't a real API response
    // (e.g., could be a late-firing event after chat load)
    if (!pendingInputTokensPromise) {
        console.log(`[Token Usage Tracker] Skipping message with no pending token count (type: ${type || 'unknown'})`);
        return;
    }

    try {
        const context = getContext();
        const message = context.chat[messageIndex];

        if (!message || !message.mes) return;

        let outputTokens;

        // Use SillyTavern's pre-calculated token count if available
        // This already includes reasoning tokens when power_user.message_token_count_enabled is true
        if (message.extra?.token_count && typeof message.extra.token_count === 'number') {
            outputTokens = message.extra.token_count;
            console.log(`[Token Usage Tracker] Using pre-calculated token count: ${outputTokens}`);
        } else {
            // Fall back to manual counting
            outputTokens = await countTokens(message.mes);

            // Also count reasoning/thinking tokens (from Claude thinking, OpenAI o1, etc.)
            if (message.extra?.reasoning) {
                const reasoningTokens = await countTokens(message.extra.reasoning);
                outputTokens += reasoningTokens;
                console.log(`[Token Usage Tracker] Including ${reasoningTokens} reasoning tokens`);
            }
            console.log(`[Token Usage Tracker] Manually counted tokens: ${outputTokens}`);
        }

        // For 'continue' type, we only want the newly generated tokens, not the full message
        // Subtract the pre-continue token count to get just the delta
        if (type === 'continue' && preContinueTokenCount > 0) {
            const originalOutputTokens = outputTokens;
            outputTokens = Math.max(0, outputTokens - preContinueTokenCount);
            console.log(`[Token Usage Tracker] Continue type: ${originalOutputTokens} total - ${preContinueTokenCount} pre-continue = ${outputTokens} new tokens`);
        }

        // Reset pre-continue state
        const savedPreContinueCount = preContinueTokenCount;
        preContinueTokenCount = 0;

        // Await the input token counting that was started in handleGenerateAfterData
        const inputTokens = await pendingInputTokensPromise;
        const modelId = pendingModelId;
        pendingInputTokensPromise = null;
        pendingModelId = null;

        // Get current chat ID if available
        const chatId = context.chatMetadata?.chat_id || null;

        recordUsage(inputTokens, outputTokens, chatId, modelId);

        console.log(`[Token Usage Tracker] Recorded exchange: ${inputTokens} in, ${outputTokens} out, model: ${modelId || 'unknown'}${savedPreContinueCount > 0 ? ' (continue delta)' : ''}`);
    } catch (error) {
        console.error('[Token Usage Tracker] Error counting output tokens:', error);
    }
}

/**
 * Handle generation stopped event - count tokens for cancelled/stopped generations
 * This ensures that input tokens (which were sent to the API) are still counted,
 * along with any partial output tokens that were generated before stopping.
 */
async function handleGenerationStopped() {
    // If there's no pending token counting promise, nothing to record
    if (!pendingInputTokensPromise) return;

    try {
        let outputTokens = 0;

        // Try to get partial output from the streaming processor
        if (streamingProcessor) {
            // Count main response text
            if (streamingProcessor.result) {
                outputTokens = await countTokens(streamingProcessor.result);
                console.log(`[Token Usage Tracker] Partial output from stopped generation: ${outputTokens} tokens`);
            }

            // Also count any reasoning tokens that were generated
            if (streamingProcessor.reasoningHandler?.reasoning) {
                const reasoningTokens = await countTokens(streamingProcessor.reasoningHandler.reasoning);
                outputTokens += reasoningTokens;
                console.log(`[Token Usage Tracker] Including ${reasoningTokens} partial reasoning tokens`);
            }
        }

        // Await the input token counting that was started in handleGenerateAfterData
        const inputTokens = await pendingInputTokensPromise;
        const modelId = pendingModelId;
        pendingInputTokensPromise = null;
        pendingModelId = null;
        preContinueTokenCount = 0; // Reset continue state too

        // Get current chat ID if available
        const context = getContext();
        const chatId = context.chatMetadata?.chat_id || null;

        // Record the usage - input tokens were sent even if generation was stopped
        recordUsage(inputTokens, outputTokens, chatId, modelId);

        console.log(`[Token Usage Tracker] Recorded stopped generation: ${inputTokens} in, ${outputTokens} out (partial), model: ${modelId || 'unknown'}`);
    } catch (error) {
        console.error('[Token Usage Tracker] Error handling stopped generation:', error);
        // Reset pending tokens even on error to prevent double counting
        pendingInputTokensPromise = null;
        preContinueTokenCount = 0;
    }
}

/**
 * Handle chat changed event
 */
function handleChatChanged(chatId) {
    // Reset pending tokens when chat changes to prevent cross-chat counting
    pendingInputTokensPromise = null;
    pendingModelId = null;
    preContinueTokenCount = 0;
    isQuietGeneration = false;
    isImpersonateGeneration = false;
    console.log(`[Token Usage Tracker] Chat changed to: ${chatId}`);
    eventSource.emit('tokenUsageUpdated', getUsageStats());
}

/**
 * Handle impersonate ready event - count output tokens for impersonation
 * This fires when impersonation completes and puts text into the input field
 * @param {string} text - The generated impersonation text
 */
async function handleImpersonateReady(text) {
    if (!pendingInputTokensPromise) return;

    try {

        // Await the input token counting that was started in handleGenerateAfterData
        const inputTokens = await pendingInputTokensPromise;
        const modelId = pendingModelId;
        pendingInputTokensPromise = null;
        pendingModelId = null;

        // Count output tokens from the impersonated text
        let outputTokens = 0;
        if (text && typeof text === 'string') {
            outputTokens = await countTokens(text);
        }

        // Get current chat ID if available
        const context = getContext();
        const chatId = context.chatMetadata?.chat_id || null;

        recordUsage(inputTokens, outputTokens, chatId, modelId);


        // Reset impersonate state
        isImpersonateGeneration = false;
    } catch (error) {
        console.error('[Token Usage Tracker] Error handling impersonate ready:', error);
        pendingInputTokensPromise = null;
        pendingModelId = null;
        isImpersonateGeneration = false;
    }
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenusage',
        callback: async () => {
            const stats = getUsageStats();
            const output = [
                `Tokenizer: ${stats.tokenizer}`,
                `Today: ${stats.today.total} tokens`,
                `This Week: ${stats.thisWeek.total} tokens`,
                `This Month: ${stats.thisMonth.total} tokens`,
                `All Time: ${stats.allTime.total} tokens`,
            ].join('\n');
            return output;
        },
        returns: 'Token usage statistics',
        helpString: 'Displays current token usage statistics across different time periods.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenreset',
        callback: async () => {
            if (confirm('Are you sure you want to reset all token usage data?')) {
                resetAllUsage();
                return 'All token usage data has been reset.';
            }
            return 'Reset cancelled.';
        },
        returns: 'Confirmation message',
        helpString: 'Resets all token usage data.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenstats',
        callback: async () => {
            await showDetailedStatsPopup();
            return '';
        },
        returns: 'Opens detailed stats popup',
        helpString: 'Opens a detailed popup with token usage statistics, charts, and model breakdown.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokensettings',
        callback: async () => {
            await showSettingsPopup();
            return '';
        },
        returns: 'Opens settings popup',
        helpString: 'Opens the Token Usage Tracker settings popup.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tokenexport',
        callback: async () => {
            exportUsageData();
            return 'Token usage data exported.';
        },
        returns: 'Confirmation message',
        helpString: 'Exports all token usage data as a JSON file.',
    }));
}

/**
 * Public API exposed for frontend/UI components
 */
window['TokenUsageTracker'] = {
    getStats: getUsageStats,
    getUsageForRange,
    getChatUsage,
    resetAllUsage,
    recordUsage,
    countTokens, // Expose the token counting function
    // Subscribe to updates
    onUpdate: (callback) => {
        eventSource.on('tokenUsageUpdated', callback);
    },
    // Unsubscribe from updates
    offUpdate: (callback) => {
        eventSource.removeListener('tokenUsageUpdated', callback);
    },
};

/**
 * Format token count with K/M suffix
 */
function formatTokens(count) {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
    return count.toString();
}

/**
 * Format number with commas
 */
function formatNumberFull(num) {
    return new Intl.NumberFormat('en-US').format(num);
}

/**
 * Generate a random color using HSL for guaranteed distinctness
 * Colors are persisted once assigned to maintain consistency
 * @param {string} modelId - Model identifier
 * @returns {string} Hex color code
 */
function getModelColor(modelId) {
    const settings = getSettings();

    // Return persisted color if exists
    if (settings.modelColors[modelId]) {
        return settings.modelColors[modelId];
    }

    // Get all existing assigned colors to avoid duplicates
    const existingColors = Object.values(settings.modelColors);

    // Generate a random color that's distinct from existing ones
    let newColor;
    let attempts = 0;
    do {
        // Random hue (0-360), high saturation (60-80%), medium lightness (45-65%)
        const hue = Math.floor(Math.random() * 360);
        const sat = 60 + Math.floor(Math.random() * 20);
        const light = 45 + Math.floor(Math.random() * 20);
        newColor = hslToHex(hue, sat, light);
        attempts++;
    } while (attempts < 50 && isTooSimilar(newColor, existingColors));

    // Persist the new color
    settings.modelColors[modelId] = newColor;
    saveSettings();

    return newColor;
}

/**
 * Convert HSL to hex color
 */
function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Check if a color is too similar to any existing colors
 */
function isTooSimilar(newColor, existingColors) {
    for (const existing of existingColors) {
        if (colorDistance(newColor, existing) < 50) {
            return true;
        }
    }
    return false;
}

/**
 * Calculate color distance (simple RGB euclidean)
 */
function colorDistance(c1, c2) {
    const r1 = parseInt(c1.slice(1, 3), 16);
    const g1 = parseInt(c1.slice(3, 5), 16);
    const b1 = parseInt(c1.slice(5, 7), 16);
    const r2 = parseInt(c2.slice(1, 3), 16);
    const g2 = parseInt(c2.slice(3, 5), 16);
    const b2 = parseInt(c2.slice(5, 7), 16);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

/**
 * Set color for a model
 * @param {string} modelId - Model identifier
 * @param {string} color - Hex color code
 */
function setModelColor(modelId, color) {
    const settings = getSettings();
    settings.modelColors[modelId] = color;
    saveSettings();
}

/**
 * Get price settings for a model
 * @param {string} modelId
 * @returns {{in: number, out: number}} Price per 1M tokens
 */
function getModelPrice(modelId) {
    const settings = getSettings();
    return settings.modelPrices[modelId] || { in: 0, out: 0 };
}

/**
 * Set price settings for a model
 * @param {string} modelId
 * @param {string|number} priceIn - Price per 1M input tokens
 * @param {string|number} priceOut - Price per 1M output tokens
 */
function setModelPrice(modelId, priceIn, priceOut) {
    const settings = getSettings();
    settings.modelPrices[modelId] = {
        in: parseFloat(String(priceIn)) || 0,
        out: parseFloat(String(priceOut)) || 0
    };
    saveSettings();
}

/**
 * Calculate cost for a given token usage and model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} modelId
 * @returns {number} Cost in dollars
 */
function calculateCost(inputTokens, outputTokens, modelId) {
    const prices = getModelPrice(modelId);
    if (!prices.in && !prices.out) return 0;

    const inputCost = (inputTokens / 1000000) * prices.in;
    const outputCost = (outputTokens / 1000000) * prices.out;
    return inputCost + outputCost;
}

/**
 * Calculate all-time cost using the byModel aggregation which has precise input/output counts
 */
function calculateAllTimeCost() {
    const settings = getSettings();
    const byModel = settings.usage.byModel;
    let totalCost = 0;

    for (const [modelId, data] of Object.entries(byModel)) {
        totalCost += calculateCost(data.input, data.output, modelId);
    }
    return totalCost;
}

/**
 * Get hourly chart data for the last N hours
 * @param {number} hours - Number of hours to retrieve
 */
function getHourlyChartData(hours = 24) {
    const stats = getUsageStats();
    const byHour = stats.byHour || {};
    const data = [];
    const now = new Date();

    for (let i = hours - 1; i >= 0; i--) {
        const date = new Date(now);
        date.setHours(date.getHours() - i);
        const hourKey = getHourKey(date);
        const hourData = byHour[hourKey] || { total: 0, input: 0, output: 0 };

        data.push({
            date: date,
            hourKey: hourKey,
            usage: hourData.total || 0,
            input: hourData.input || 0,
            output: hourData.output || 0,
            displayTime: date.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true }),
            fullTime: date.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        });
    }
    return data;
}

/**
 * Get monthly chart data for the last N months
 * @param {number} months - Number of months to retrieve
 */
function getMonthlyChartData(months = 12) {
    const stats = getUsageStats();
    const byMonth = stats.byMonth || {};
    const data = [];
    const now = new Date();

    for (let i = months - 1; i >= 0; i--) {
        const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthKey = getMonthKey(date);
        const monthData = byMonth[monthKey] || { total: 0, input: 0, output: 0, messageCount: 0 };

        data.push({
            date: date,
            monthKey: monthKey,
            usage: monthData.total || 0,
            input: monthData.input || 0,
            output: monthData.output || 0,
            messageCount: monthData.messageCount || 0,
            displayMonth: date.toLocaleDateString('en-US', { month: 'short' }),
            fullMonth: date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
        });
    }
    return data;
}

/**
 * Get weekly chart data for the last N weeks
 * @param {number} weeks - Number of weeks to retrieve
 */
function getWeeklyChartData(weeks = 12) {
    const stats = getUsageStats();
    const byDay = stats.byDay || {};
    const data = [];
    const now = new Date();

    for (let i = weeks - 1; i >= 0; i--) {
        // Get start of week (i weeks ago)
        const weekStart = new Date(now);
        weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + i * 7));
        weekStart.setHours(0, 0, 0, 0);

        let weekTotal = 0, weekInput = 0, weekOutput = 0, weekMessages = 0;

        // Sum all days in this week
        for (let d = 0; d < 7; d++) {
            const dayDate = new Date(weekStart);
            dayDate.setDate(dayDate.getDate() + d);
            const dayKey = getDayKey(dayDate);
            const dayData = byDay[dayKey];
            if (dayData) {
                weekTotal += dayData.total || 0;
                weekInput += dayData.input || 0;
                weekOutput += dayData.output || 0;
                weekMessages += dayData.messageCount || 0;
            }
        }

        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);

        data.push({
            date: weekStart,
            weekStart: weekStart,
            weekEnd: weekEnd,
            usage: weekTotal,
            input: weekInput,
            output: weekOutput,
            messageCount: weekMessages,
            displayWeek: `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
            fullWeek: `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
        });
    }
    return data;
}

/**
 * Get input vs output comparison data (daily)
 * @param {number} days - Number of days to retrieve
 */
function getInputOutputChartData(days = 30) {
    const chartData = getChartData(days);
    return chartData.map(d => ({
        ...d,
        displayDate: d.displayDate,
        fullDate: d.fullDate
    }));
}

/**
 * Get cumulative usage data (daily)
 * @param {number} days - Number of days to retrieve
 */
function getCumulativeChartData(days = 30) {
    const chartData = getChartData(days);
    let runningTotal = 0;
    return chartData.map(d => {
        runningTotal += d.usage;
        return {
            ...d,
            cumulative: runningTotal,
            displayDate: d.displayDate,
            fullDate: d.fullDate
        };
    });
}

/**
 * Get cost trend data (daily)
 * @param {number} days - Number of days to retrieve
 */
function getCostChartData(days = 30) {
    const stats = getUsageStats();
    const byDay = stats.byDay || {};
    const data = [];
    const now = new Date();

    for (let i = days - 1; i >= 0; i--) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        const dayKey = getDayKey(date);
        const dayData = byDay[dayKey] || { total: 0, input: 0, output: 0, models: {} };

        // Calculate cost for this day using model-specific prices
        let dayCost = 0;
        if (dayData.models) {
            for (const [modelId, mData] of Object.entries(dayData.models)) {
                const mInput = typeof mData === 'number' ? 0 : (mData.input || 0);
                const mOutput = typeof mData === 'number' ? 0 : (mData.output || 0);
                dayCost += calculateCost(mInput, mOutput, modelId);
            }
        }

        data.push({
            date: date,
            dayKey: dayKey,
            cost: dayCost,
            input: dayData.input || 0,
            output: dayData.output || 0,
            usage: dayData.total || 0,
            displayDate: date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
            fullDate: date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
        });
    }
    return data;
}

/**
 * Get model breakdown data
 */
function getModelBreakdownData() {
    const stats = getUsageStats();
    const byModel = stats.byModel || {};
    const data = [];

    for (const [modelId, modelData] of Object.entries(byModel)) {
        const cost = calculateCost(modelData.input, modelData.output, modelId);
        data.push({
            modelId,
            input: modelData.input || 0,
            output: modelData.output || 0,
            total: modelData.total || 0,
            messageCount: modelData.messageCount || 0,
            cost,
            color: getModelColor(modelId)
        });
    }

    // Sort by total tokens descending
    data.sort((a, b) => b.total - a.total);
    return data;
}

/**
 * Show the detailed stats popup
 */
async function showDetailedStatsPopup() {
    const stats = getUsageStats();
    const settings = getSettings();
    const modelData = getModelBreakdownData();
    const allTimeCost = calculateAllTimeCost();

    // Calculate costs for different periods
    const now = new Date();
    const currentMonthKey = getMonthKey(now);
    const currentWeekKey = getWeekKey(now);
    const todayKey = getDayKey(now);

    let monthCost = 0, weekCost = 0, todayCost = 0;
    for (const [dayKey, data] of Object.entries(settings.usage.byDay)) {
        const [year, month, day] = dayKey.split('-').map(Number);
        const date = new Date(year, month - 1, day);

        if (data.models) {
            for (const [mid, mData] of Object.entries(data.models)) {
                const mInput = typeof mData === 'number' ? 0 : (mData.input || 0);
                const mOutput = typeof mData === 'number' ? 0 : (mData.output || 0);
                const cost = calculateCost(mInput, mOutput, mid);

                if (getMonthKey(date) === currentMonthKey) monthCost += cost;
                if (getWeekKey(date) === currentWeekKey) weekCost += cost;
                if (dayKey === todayKey) todayCost += cost;
            }
        }
    }

    // Build model breakdown table
    let modelTableRows = '';
    for (const model of modelData) {
        const shortName = model.modelId.length > 30 ? model.modelId.substring(0, 27) + '...' : model.modelId;
        modelTableRows += `
            <tr>
                <td style="display: flex; align-items: center; gap: 8px;">
                    <span style="display: inline-block; width: 12px; height: 12px; background: ${model.color}; border-radius: 3px;"></span>
                    <span title="${model.modelId}">${shortName}</span>
                </td>
                <td style="text-align: right;">${formatNumberFull(model.input)}</td>
                <td style="text-align: right;">${formatNumberFull(model.output)}</td>
                <td style="text-align: right; font-weight: 600;">${formatNumberFull(model.total)}</td>
                <td style="text-align: right;">${model.messageCount}</td>
                <td style="text-align: right; color: ${model.cost > 0 ? 'var(--SmartThemeQuoteColor)' : 'inherit'};">$${model.cost.toFixed(4)}</td>
            </tr>
        `;
    }

    const popupContent = `
        <div style="min-width: 600px; max-width: 900px;">
            <h3 style="margin: 0 0 16px 0; display: flex; align-items: center; gap: 8px;">
                <i class="fa-solid fa-chart-line"></i> Token Usage Statistics
            </h3>

            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px;">
                <div style="background: var(--SmartThemeBlurTintColor); padding: 12px; border-radius: 8px; border: 1px solid var(--SmartThemeBorderColor);">
                    <div style="font-size: 11px; opacity: 0.6; margin-bottom: 4px;">Today</div>
                    <div style="font-size: 20px; font-weight: 600;">${formatTokens(stats.today.total)}</div>
                    <div style="font-size: 11px; opacity: 0.7;">$${todayCost.toFixed(2)}</div>
                </div>
                <div style="background: var(--SmartThemeBlurTintColor); padding: 12px; border-radius: 8px; border: 1px solid var(--SmartThemeBorderColor);">
                    <div style="font-size: 11px; opacity: 0.6; margin-bottom: 4px;">This Week</div>
                    <div style="font-size: 20px; font-weight: 600;">${formatTokens(stats.thisWeek.total)}</div>
                    <div style="font-size: 11px; opacity: 0.7;">$${weekCost.toFixed(2)}</div>
                </div>
                <div style="background: var(--SmartThemeBlurTintColor); padding: 12px; border-radius: 8px; border: 1px solid var(--SmartThemeBorderColor);">
                    <div style="font-size: 11px; opacity: 0.6; margin-bottom: 4px;">This Month</div>
                    <div style="font-size: 20px; font-weight: 600;">${formatTokens(stats.thisMonth.total)}</div>
                    <div style="font-size: 11px; opacity: 0.7;">$${monthCost.toFixed(2)}</div>
                </div>
                <div style="background: var(--SmartThemeBlurTintColor); padding: 12px; border-radius: 8px; border: 1px solid var(--SmartThemeBorderColor);">
                    <div style="font-size: 11px; opacity: 0.6; margin-bottom: 4px;">All Time</div>
                    <div style="font-size: 20px; font-weight: 600;">${formatTokens(stats.allTime.total)}</div>
                    <div style="font-size: 11px; opacity: 0.7;">$${allTimeCost.toFixed(2)}</div>
                </div>
            </div>

            <div style="margin-bottom: 12px;">
                <div style="display: flex; gap: 4px; margin-bottom: 12px; flex-wrap: wrap;">
                    <button class="menu_button popup-chart-tab active" data-view="daily" style="padding: 6px 12px; font-size: 12px;">
                        <i class="fa-solid fa-calendar-day"></i> Daily
                    </button>
                    <button class="menu_button popup-chart-tab" data-view="weekly" style="padding: 6px 12px; font-size: 12px;">
                        <i class="fa-solid fa-calendar-week"></i> Weekly
                    </button>
                    <button class="menu_button popup-chart-tab" data-view="monthly" style="padding: 6px 12px; font-size: 12px;">
                        <i class="fa-solid fa-calendar"></i> Monthly
                    </button>
                    <button class="menu_button popup-chart-tab" data-view="hourly" style="padding: 6px 12px; font-size: 12px;">
                        <i class="fa-solid fa-clock"></i> Hourly
                    </button>
                    <button class="menu_button popup-chart-tab" data-view="inout" style="padding: 6px 12px; font-size: 12px;">
                        <i class="fa-solid fa-arrows-left-right"></i> Input vs Output
                    </button>
                    <button class="menu_button popup-chart-tab" data-view="cumulative" style="padding: 6px 12px; font-size: 12px;">
                        <i class="fa-solid fa-chart-line"></i> Cumulative
                    </button>
                    <button class="menu_button popup-chart-tab" data-view="models" style="padding: 6px 12px; font-size: 12px;">
                        <i class="fa-solid fa-robot"></i> By Model
                    </button>
                    <button class="menu_button popup-chart-tab" data-view="cost" style="padding: 6px 12px; font-size: 12px;">
                        <i class="fa-solid fa-dollar-sign"></i> Cost Trend
                    </button>
                </div>
                <div id="popup-chart-container" style="width: 100%; height: 250px; background: var(--SmartThemeBlurTintColor); border-radius: 8px; border: 1px solid var(--SmartThemeBorderColor); overflow: hidden;"></div>
            </div>

            <div style="margin-top: 20px;">
                <h4 style="margin: 0 0 12px 0; font-size: 14px;">
                    <i class="fa-solid fa-table"></i> Model Breakdown
                </h4>
                <div style="max-height: 200px; overflow-y: auto; border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                        <thead style="position: sticky; top: 0; background: var(--SmartThemeBlurTintColor);">
                            <tr style="border-bottom: 1px solid var(--SmartThemeBorderColor);">
                                <th style="padding: 8px; text-align: left;">Model</th>
                                <th style="padding: 8px; text-align: right;">Input</th>
                                <th style="padding: 8px; text-align: right;">Output</th>
                                <th style="padding: 8px; text-align: right;">Total</th>
                                <th style="padding: 8px; text-align: right;">Messages</th>
                                <th style="padding: 8px; text-align: right;">Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${modelTableRows || '<tr><td colspan="6" style="padding: 16px; text-align: center; opacity: 0.5;">No model data yet</td></tr>'}
                        </tbody>
                    </table>
                </div>
            </div>

            <div style="margin-top: 16px; padding: 12px; background: var(--SmartThemeBlurTintColor); border-radius: 8px; border: 1px solid var(--SmartThemeBorderColor);">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div>
                        <div style="font-size: 11px; opacity: 0.6;">Total Messages</div>
                        <div style="font-size: 14px; font-weight: 600;">${formatNumberFull(stats.allTime.messageCount)} messages</div>
                        <div style="font-size: 10px; opacity: 0.5;">Average: ${stats.allTime.messageCount > 0 ? formatNumberFull(Math.round(stats.allTime.total / stats.allTime.messageCount)) : 0} tokens/message</div>
                    </div>
                    <div>
                        <div style="font-size: 11px; opacity: 0.6;">Tokenizer</div>
                        <div style="font-size: 12px;">${stats.tokenizer || 'Unknown'}</div>
                    </div>
                </div>
            </div>
        </div>
    `;

    const popup = new Popup(popupContent, POPUP_TYPE.TEXT, '', {
        okButton: 'Close',
        wide: true,
        allowVerticalScrolling: true,
        onOpen: () => {
            initPopupCharts();
        }
    });

    await popup.show();
}

/**
 * Initialize charts in the popup
 */
function initPopupCharts() {
    const container = document.getElementById('popup-chart-container');
    if (!container) return;

    // Render default view (daily)
    renderPopupChart('daily');

    // Tab click handlers
    document.querySelectorAll('.popup-chart-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.popup-chart-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const view = tab.getAttribute('data-view');
            renderPopupChart(view);
        });
    });
}

/**
 * Render chart in popup based on view type
 * @param {string} view - 'daily', 'weekly', 'hourly', 'monthly', 'models', 'inout', 'cumulative', 'cost'
 */
function renderPopupChart(view) {
    const container = document.getElementById('popup-chart-container');
    if (!container) return;

    container.innerHTML = '';

    switch (view) {
        case 'daily':
            renderBarChartInContainer(container, getChartData(30), 'displayDate', 'fullDate');
            break;
        case 'weekly':
            renderBarChartInContainer(container, getWeeklyChartData(12), 'displayWeek', 'fullWeek');
            break;
        case 'hourly':
            renderBarChartInContainer(container, getHourlyChartData(24), 'displayTime', 'fullTime');
            break;
        case 'monthly':
            renderBarChartInContainer(container, getMonthlyChartData(12), 'displayMonth', 'fullMonth');
            break;
        case 'models':
            renderModelPieChart(container);
            break;
        case 'inout':
            renderInputOutputChart(container, getInputOutputChartData(30));
            break;
        case 'cumulative':
            renderCumulativeChart(container, getCumulativeChartData(30));
            break;
        case 'cost':
            renderCostChart(container, getCostChartData(30));
            break;
    }
}

/**
 * Render a bar chart in a specific container
 */
function renderBarChartInContainer(container, data, labelKey, tooltipKey) {
    const rect = container.getBoundingClientRect();
    const width = rect.width || 400;
    const height = rect.height || 200;

    if (data.length === 0) {
        container.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--SmartThemeBodyColor); opacity: 0.5;">No data available</div>';
        return;
    }

    const margin = { top: 15, right: 15, bottom: 30, left: 50 };
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;

    const svg = createSVGElement('svg', {
        width: width,
        height: height,
        viewBox: `0 0 ${width} ${height}`,
        style: 'display: block;'
    });

    const maxUsage = Math.max(...data.map(d => d.usage), 1);
    const niceMax = Math.ceil(maxUsage * 1.1 / 1000) * 1000 || 1000;
    const yScale = (val) => chartHeight - (val / niceMax) * chartHeight;

    // Grid lines
    const gridGroup = createSVGElement('g');
    for (let i = 0; i <= 4; i++) {
        const val = (niceMax / 4) * i;
        const y = margin.top + yScale(val);
        const line = createSVGElement('line', {
            x1: margin.left, y1: y, x2: width - margin.right, y2: y,
            stroke: 'var(--SmartThemeBorderColor)', 'stroke-width': '1', 'stroke-dasharray': '4 4'
        });
        gridGroup.appendChild(line);

        const text = createSVGElement('text', {
            x: margin.left - 8, y: y + 4, 'text-anchor': 'end',
            fill: 'var(--SmartThemeBodyColor)', 'font-size': '10', opacity: '0.7'
        });
        text.textContent = formatTokens(val);
        gridGroup.appendChild(text);
    }
    svg.appendChild(gridGroup);

    // Bars
    const barGroup = createSVGElement('g');
    const totalBarWidth = chartWidth / data.length;
    const barWidth = Math.min(totalBarWidth * 0.7, 30);
    const labelInterval = data.length > 20 ? Math.ceil(data.length / 10) : 1;

    data.forEach((d, i) => {
        const slotX = margin.left + (i * totalBarWidth);
        const barX = slotX + (totalBarWidth - barWidth) / 2;
        const barH = (d.usage / niceMax) * chartHeight;
        const barY = margin.top + (chartHeight - barH);

        // Bar
        const bar = createSVGElement('rect', {
            x: barX, y: barY, width: barWidth, height: Math.max(barH, 1),
            fill: 'var(--SmartThemeQuoteColor)', rx: '3', ry: '3',
            style: 'cursor: pointer;'
        });

        // Hover effect
        bar.addEventListener('mouseenter', () => {
            bar.setAttribute('opacity', '0.8');
        });
        bar.addEventListener('mouseleave', () => {
            bar.setAttribute('opacity', '1');
        });

        barGroup.appendChild(bar);

        // X labels
        if (i % labelInterval === 0) {
            const label = createSVGElement('text', {
                x: barX + barWidth / 2, y: height - 8, 'text-anchor': 'middle',
                fill: 'var(--SmartThemeBodyColor)', 'font-size': '10', opacity: '0.6'
            });
            label.textContent = d[labelKey];
            barGroup.appendChild(label);
        }
    });
    svg.appendChild(barGroup);

    container.appendChild(svg);
}

/**
 * Render a pie/donut chart for model breakdown
 */
function renderModelPieChart(container) {
    const data = getModelBreakdownData();
    const rect = container.getBoundingClientRect();
    const width = rect.width || 400;
    const height = rect.height || 200;

    if (data.length === 0) {
        container.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--SmartThemeBodyColor); opacity: 0.5;">No model data yet</div>';
        return;
    }

    const total = data.reduce((sum, d) => sum + d.total, 0);
    const centerX = width / 3;
    const centerY = height / 2;
    const radius = Math.min(centerX, centerY) - 20;
    const innerRadius = radius * 0.5;

    const svg = createSVGElement('svg', {
        width: width, height: height, viewBox: `0 0 ${width} ${height}`, style: 'display: block;'
    });

    let currentAngle = -Math.PI / 2;
    const arcGroup = createSVGElement('g');

    data.forEach((d) => {
        const sliceAngle = (d.total / total) * 2 * Math.PI;
        const endAngle = currentAngle + sliceAngle;

        const x1 = centerX + radius * Math.cos(currentAngle);
        const y1 = centerY + radius * Math.sin(currentAngle);
        const x2 = centerX + radius * Math.cos(endAngle);
        const y2 = centerY + radius * Math.sin(endAngle);
        const ix1 = centerX + innerRadius * Math.cos(currentAngle);
        const iy1 = centerY + innerRadius * Math.sin(currentAngle);
        const ix2 = centerX + innerRadius * Math.cos(endAngle);
        const iy2 = centerY + innerRadius * Math.sin(endAngle);

        const largeArc = sliceAngle > Math.PI ? 1 : 0;

        const pathD = `M ${ix1} ${iy1} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix1} ${iy1} Z`;

        const path = createSVGElement('path', {
            d: pathD, fill: d.color, stroke: 'var(--SmartThemeBodyColor)', 'stroke-width': '1',
            style: 'cursor: pointer;'
        });
        path.addEventListener('mouseenter', () => path.setAttribute('opacity', '0.8'));
        path.addEventListener('mouseleave', () => path.setAttribute('opacity', '1'));
        arcGroup.appendChild(path);

        currentAngle = endAngle;
    });
    svg.appendChild(arcGroup);

    // Center text
    const centerText = createSVGElement('text', {
        x: centerX, y: centerY - 5, 'text-anchor': 'middle',
        fill: 'var(--SmartThemeBodyColor)', 'font-size': '14', 'font-weight': '600'
    });
    centerText.textContent = formatTokens(total);
    svg.appendChild(centerText);

    const centerLabel = createSVGElement('text', {
        x: centerX, y: centerY + 12, 'text-anchor': 'middle',
        fill: 'var(--SmartThemeBodyColor)', 'font-size': '10', opacity: '0.6'
    });
    centerLabel.textContent = 'total tokens';
    svg.appendChild(centerLabel);

    // Legend
    const legendX = width / 2 + 20;
    let legendY = 20;
    const maxLegendItems = Math.floor((height - 40) / 22);
    const displayData = data.slice(0, maxLegendItems);

    displayData.forEach((d) => {
        const percent = ((d.total / total) * 100).toFixed(1);
        const shortName = d.modelId.length > 20 ? d.modelId.substring(0, 17) + '...' : d.modelId;

        const rect = createSVGElement('rect', {
            x: legendX, y: legendY, width: 12, height: 12, fill: d.color, rx: '2'
        });
        svg.appendChild(rect);

        const text = createSVGElement('text', {
            x: legendX + 18, y: legendY + 10,
            fill: 'var(--SmartThemeBodyColor)', 'font-size': '11'
        });
        text.textContent = `${shortName} (${percent}%)`;
        svg.appendChild(text);

        legendY += 22;
    });

    if (data.length > maxLegendItems) {
        const moreText = createSVGElement('text', {
            x: legendX, y: legendY + 10,
            fill: 'var(--SmartThemeBodyColor)', 'font-size': '10', opacity: '0.5'
        });
        moreText.textContent = `+${data.length - maxLegendItems} more`;
        svg.appendChild(moreText);
    }

    container.appendChild(svg);
}

/**
 * Render Input vs Output stacked bar chart
 */
function renderInputOutputChart(container, data) {
    const rect = container.getBoundingClientRect();
    const width = rect.width || 400;
    const height = rect.height || 200;

    if (data.length === 0) {
        container.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--SmartThemeBodyColor); opacity: 0.5;">No data available</div>';
        return;
    }

    const padding = { top: 20, right: 20, bottom: 35, left: 50 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const maxValue = Math.max(...data.map(d => d.input + d.output), 1);

    const svg = createSVGElement('svg', {
        width: width, height: height, viewBox: `0 0 ${width} ${height}`, style: 'display: block;'
    });

    const barWidth = Math.max(3, (chartWidth / data.length) - 2);
    const barGroup = createSVGElement('g');

    // Y-axis gridlines
    const gridLinesGroup = createSVGElement('g');
    for (let i = 0; i <= 4; i++) {
        const y = padding.top + (chartHeight * (1 - i / 4));
        const line = createSVGElement('line', {
            x1: padding.left, y1: y, x2: width - padding.right, y2: y,
            stroke: 'var(--SmartThemeBorderColor)', 'stroke-opacity': '0.3'
        });
        gridLinesGroup.appendChild(line);

        const label = createSVGElement('text', {
            x: padding.left - 5, y: y + 3, 'text-anchor': 'end',
            fill: 'var(--SmartThemeBodyColor)', 'font-size': '9', opacity: '0.5'
        });
        label.textContent = formatTokens(Math.round(maxValue * i / 4));
        gridLinesGroup.appendChild(label);
    }
    svg.appendChild(gridLinesGroup);

    // Stacked bars
    data.forEach((d, i) => {
        const x = padding.left + (i / data.length) * chartWidth;
        const inputHeight = (d.input / maxValue) * chartHeight;
        const outputHeight = (d.output / maxValue) * chartHeight;

        // Input bar (bottom)
        const inputBar = createSVGElement('rect', {
            x: x, y: padding.top + chartHeight - inputHeight - outputHeight,
            width: barWidth, height: inputHeight,
            fill: '#6366f1', rx: '1'
        });
        inputBar.addEventListener('mouseenter', () => {
            // @ts-ignore
            inputBar.setAttribute('opacity', '0.8');
        });
        inputBar.addEventListener('mouseleave', () => {
            // @ts-ignore
            inputBar.setAttribute('opacity', '1');
        });
        barGroup.appendChild(inputBar);

        // Output bar (top, stacked)
        const outputBar = createSVGElement('rect', {
            x: x, y: padding.top + chartHeight - outputHeight,
            width: barWidth, height: outputHeight,
            fill: '#f59e0b', rx: '1'
        });
        outputBar.addEventListener('mouseenter', () => {
            // @ts-ignore
            outputBar.setAttribute('opacity', '0.8');
        });
        outputBar.addEventListener('mouseleave', () => {
            // @ts-ignore
            outputBar.setAttribute('opacity', '1');
        });
        barGroup.appendChild(outputBar);
    });
    svg.appendChild(barGroup);

    // Legend
    const legendGroup = createSVGElement('g');
    const legendInputRect = createSVGElement('rect', { x: padding.left, y: 5, width: 12, height: 12, fill: '#6366f1', rx: '2' });
    const legendInputText = createSVGElement('text', { x: padding.left + 16, y: 14, fill: 'var(--SmartThemeBodyColor)', 'font-size': '10' });
    legendInputText.textContent = 'Input';
    const legendOutputRect = createSVGElement('rect', { x: padding.left + 55, y: 5, width: 12, height: 12, fill: '#f59e0b', rx: '2' });
    const legendOutputText = createSVGElement('text', { x: padding.left + 71, y: 14, fill: 'var(--SmartThemeBodyColor)', 'font-size': '10' });
    legendOutputText.textContent = 'Output';
    legendGroup.appendChild(legendInputRect);
    legendGroup.appendChild(legendInputText);
    legendGroup.appendChild(legendOutputRect);
    legendGroup.appendChild(legendOutputText);
    svg.appendChild(legendGroup);

    container.appendChild(svg);
}

/**
 * Render cumulative line chart
 */
function renderCumulativeChart(container, data) {
    const rect = container.getBoundingClientRect();
    const width = rect.width || 400;
    const height = rect.height || 200;

    if (data.length === 0) {
        container.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--SmartThemeBodyColor); opacity: 0.5;">No data available</div>';
        return;
    }

    const padding = { top: 20, right: 20, bottom: 35, left: 60 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const maxValue = Math.max(...data.map(d => d.cumulative), 1);

    const svg = createSVGElement('svg', {
        width: width, height: height, viewBox: `0 0 ${width} ${height}`, style: 'display: block;'
    });

    // Y-axis gridlines
    const gridLinesGroup = createSVGElement('g');
    for (let i = 0; i <= 4; i++) {
        const y = padding.top + (chartHeight * (1 - i / 4));
        const line = createSVGElement('line', {
            x1: padding.left, y1: y, x2: width - padding.right, y2: y,
            stroke: 'var(--SmartThemeBorderColor)', 'stroke-opacity': '0.3'
        });
        gridLinesGroup.appendChild(line);

        const label = createSVGElement('text', {
            x: padding.left - 5, y: y + 3, 'text-anchor': 'end',
            fill: 'var(--SmartThemeBodyColor)', 'font-size': '9', opacity: '0.5'
        });
        label.textContent = formatTokens(Math.round(maxValue * i / 4));
        gridLinesGroup.appendChild(label);
    }
    svg.appendChild(gridLinesGroup);

    // Build the line path
    let pathD = '';
    let areaD = '';
    data.forEach((d, i) => {
        const x = padding.left + (i / (data.length - 1 || 1)) * chartWidth;
        const y = padding.top + chartHeight - (d.cumulative / maxValue) * chartHeight;
        if (i === 0) {
            pathD = `M ${x} ${y}`;
            areaD = `M ${x} ${padding.top + chartHeight} L ${x} ${y}`;
        } else {
            pathD += ` L ${x} ${y}`;
            areaD += ` L ${x} ${y}`;
        }
    });
    areaD += ` L ${padding.left + chartWidth} ${padding.top + chartHeight} Z`;

    // Area fill
    const areaPath = createSVGElement('path', {
        d: areaD, fill: 'var(--SmartThemeQuoteColor)', 'fill-opacity': '0.2'
    });
    svg.appendChild(areaPath);

    // Line
    const linePath = createSVGElement('path', {
        d: pathD, fill: 'none', stroke: 'var(--SmartThemeQuoteColor)', 'stroke-width': '2'
    });
    svg.appendChild(linePath);

    // Dots
    const dotsGroup = createSVGElement('g');
    data.forEach((d, i) => {
        const x = padding.left + (i / (data.length - 1 || 1)) * chartWidth;
        const y = padding.top + chartHeight - (d.cumulative / maxValue) * chartHeight;

        const dot = createSVGElement('circle', {
            cx: x, cy: y, r: 3,
            fill: 'var(--SmartThemeQuoteColor)', stroke: 'var(--SmartThemeBodyColor)', 'stroke-width': '1'
        });
        dotsGroup.appendChild(dot);
    });
    svg.appendChild(dotsGroup);

    // Total label at top
    const totalLabel = createSVGElement('text', {
        x: width - padding.right, y: padding.top - 5, 'text-anchor': 'end',
        fill: 'var(--SmartThemeBodyColor)', 'font-size': '11', 'font-weight': '600'
    });
    totalLabel.textContent = `Total: ${formatTokens(data.length > 0 ? data[data.length - 1].cumulative : 0)}`;
    svg.appendChild(totalLabel);

    container.appendChild(svg);
}

/**
 * Render cost trend chart
 */
function renderCostChart(container, data) {
    const rect = container.getBoundingClientRect();
    const width = rect.width || 400;
    const height = rect.height || 200;

    if (data.length === 0) {
        container.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--SmartThemeBodyColor); opacity: 0.5;">No data available</div>';
        return;
    }

    const padding = { top: 20, right: 20, bottom: 35, left: 50 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const maxCost = Math.max(...data.map(d => d.cost), 0.01);

    const svg = createSVGElement('svg', {
        width: width, height: height, viewBox: `0 0 ${width} ${height}`, style: 'display: block;'
    });

    // Y-axis gridlines
    const gridLinesGroup = createSVGElement('g');
    for (let i = 0; i <= 4; i++) {
        const y = padding.top + (chartHeight * (1 - i / 4));
        const line = createSVGElement('line', {
            x1: padding.left, y1: y, x2: width - padding.right, y2: y,
            stroke: 'var(--SmartThemeBorderColor)', 'stroke-opacity': '0.3'
        });
        gridLinesGroup.appendChild(line);

        const label = createSVGElement('text', {
            x: padding.left - 5, y: y + 3, 'text-anchor': 'end',
            fill: 'var(--SmartThemeBodyColor)', 'font-size': '9', opacity: '0.5'
        });
        label.textContent = '$' + (maxCost * i / 4).toFixed(2);
        gridLinesGroup.appendChild(label);
    }
    svg.appendChild(gridLinesGroup);

    // Bars
    const barWidth = Math.max(3, (chartWidth / data.length) - 2);
    const barGroup = createSVGElement('g');

    data.forEach((d, i) => {
        const x = padding.left + (i / data.length) * chartWidth;
        const barHeight = Math.max(0, (d.cost / maxCost) * chartHeight);
        const y = padding.top + chartHeight - barHeight;

        const bar = createSVGElement('rect', {
            x: x, y: y, width: barWidth, height: barHeight,
            fill: '#10b981', rx: '2'
        });
        bar.addEventListener('mouseenter', () => {
            // @ts-ignore
            bar.setAttribute('opacity', '0.8');
        });
        bar.addEventListener('mouseleave', () => {
            // @ts-ignore
            bar.setAttribute('opacity', '1');
        });
        barGroup.appendChild(bar);
    });
    svg.appendChild(barGroup);

    // Total cost label
    const totalCost = data.reduce((sum, d) => sum + d.cost, 0);
    const totalLabel = createSVGElement('text', {
        x: width - padding.right, y: padding.top - 5, 'text-anchor': 'end',
        fill: 'var(--SmartThemeBodyColor)', 'font-size': '11', 'font-weight': '600'
    });
    totalLabel.textContent = `30-day total: $${totalCost.toFixed(2)}`;
    svg.appendChild(totalLabel);

    container.appendChild(svg);
}

/**
 * Show the settings/configuration popup
 */
async function showSettingsPopup() {
    const settings = getSettings();

    const popupContent = `
        <div style="min-width: 450px;">
            <h3 style="margin: 0 0 16px 0; display: flex; align-items: center; gap: 8px;">
                <i class="fa-solid fa-gear"></i> Token Usage Tracker Settings
            </h3>

            <div style="margin-bottom: 16px;">
                <h4 style="margin: 0 0 8px 0; font-size: 13px; opacity: 0.8;">Display</h4>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    <label class="checkbox_label">
                        <input type="checkbox" id="tut-compact-mode" ${settings.compactMode ? 'checked' : ''}>
                        <span>Compact mode (smaller UI)</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="tut-show-costs" ${settings.showCostEstimates ? 'checked' : ''}>
                        <span>Show cost estimates</span>
                    </label>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 12px;">Default chart range:</span>
                        <select id="tut-default-range" class="text_pole" style="width: auto; padding: 4px 8px;">
                            <option value="7" ${settings.defaultChartRange === 7 ? 'selected' : ''}>7 days</option>
                            <option value="30" ${settings.defaultChartRange === 30 ? 'selected' : ''}>30 days</option>
                            <option value="90" ${settings.defaultChartRange === 90 ? 'selected' : ''}>90 days</option>
                        </select>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 12px;">Chart height:</span>
                        <input type="number" id="tut-chart-height" class="text_pole" value="${settings.chartHeight}" min="150" max="600" step="10" style="width: 80px; padding: 4px 8px;">
                        <span style="font-size: 11px; opacity: 0.5;">px</span>
                    </div>
                </div>
            </div>

            <div style="margin-bottom: 16px;">
                <h4 style="margin: 0 0 8px 0; font-size: 13px; opacity: 0.8;">Tracking</h4>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    <label class="checkbox_label">
                        <input type="checkbox" id="tut-hourly-tracking" ${settings.enableHourlyTracking ? 'checked' : ''}>
                        <span>Enable hourly tracking</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="tut-chat-tracking" ${settings.enableChatTracking ? 'checked' : ''}>
                        <span>Enable per-chat tracking</span>
                    </label>
                </div>
            </div>

            <div style="margin-bottom: 16px;">
                <h4 style="margin: 0 0 8px 0; font-size: 13px; opacity: 0.8;">Alerts & Budget</h4>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 12px;">Daily token warning:</span>
                        <input type="number" id="tut-warning-threshold" class="text_pole" value="${settings.warningThreshold || ''}" min="0" step="1000" placeholder="0 = disabled" style="width: 120px; padding: 4px 8px;">
                        <span style="font-size: 11px; opacity: 0.5;">tokens</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-size: 12px;">Monthly budget limit:</span>
                        <input type="number" id="tut-budget-limit" class="text_pole" value="${settings.budgetLimit || ''}" min="0" step="1" placeholder="0 = disabled" style="width: 120px; padding: 4px 8px;">
                        <span style="font-size: 11px; opacity: 0.5;">$ USD</span>
                    </div>
                </div>
            </div>

            <div style="margin-bottom: 16px;">
                <h4 style="margin: 0 0 8px 0; font-size: 13px; opacity: 0.8;">Model Pricing (per 1M tokens)</h4>
                <div id="tut-model-pricing" style="max-height: 200px; overflow-y: auto; border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; padding: 8px;">
                    ${renderModelPricingList()}
                </div>
            </div>

            <div style="margin-bottom: 8px;">
                <h4 style="margin: 0 0 8px 0; font-size: 13px; opacity: 0.8;">Data Management</h4>
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    <button class="menu_button" id="tut-reset-all" style="padding: 6px 12px; color: var(--warning-color);">
                        <i class="fa-solid fa-trash"></i> Reset All Data
                    </button>
                    <button class="menu_button" id="tut-export-data" style="padding: 6px 12px;">
                        <i class="fa-solid fa-download"></i> Export Data
                    </button>
                    <button class="menu_button" id="tut-import-data" style="padding: 6px 12px;">
                        <i class="fa-solid fa-upload"></i> Import Data
                    </button>
                </div>
            </div>
        </div>
    `;

    const popup = new Popup(popupContent, POPUP_TYPE.TEXT, '', {
        okButton: 'Save',
        cancelButton: 'Cancel',
        wide: false,
        allowVerticalScrolling: true,
        onOpen: () => {
            // Attach event handlers
            $('#tut-reset-all').on('click', () => {
                if (confirm('Are you sure you want to reset ALL token usage data? This cannot be undone.')) {
                    resetAllUsage();
                    // @ts-ignore
                    toastr.success('All data reset');
                }
            });

            $('#tut-export-data').on('click', () => {
                exportUsageData();
            });

            $('#tut-import-data').on('click', () => {
                importUsageData();
            });

            // Model pricing handlers
            $('#tut-model-pricing').on('input', '.model-price-in, .model-price-out', function() {
                const modelId = $(this).data('model');
                const priceIn = $(`#tut-model-pricing .model-price-in[data-model="${modelId}"]`).val();
                const priceOut = $(`#tut-model-pricing .model-price-out[data-model="${modelId}"]`).val();
                setModelPrice(modelId, String(priceIn ?? ''), String(priceOut ?? ''));
            });
        }
    });

    const result = await popup.show();

    if (result) {
        // Save settings
        settings.compactMode = $('#tut-compact-mode').is(':checked');
        settings.showCostEstimates = $('#tut-show-costs').is(':checked');
        settings.defaultChartRange = parseInt(String($('#tut-default-range').val())) || 30;
        settings.chartHeight = parseInt(String($('#tut-chart-height').val())) || 320;
        settings.enableHourlyTracking = $('#tut-hourly-tracking').is(':checked');
        settings.enableChatTracking = $('#tut-chat-tracking').is(':checked');
        settings.warningThreshold = parseInt(String($('#tut-warning-threshold').val())) || 0;
        settings.budgetLimit = parseFloat(String($('#tut-budget-limit').val())) || 0;

        saveSettings();
        updateUIStats();
        // @ts-ignore
        toastr.success('Settings saved');
    }
}

/**
 * Render the model pricing list for settings popup
 */
function renderModelPricingList() {
    const stats = getUsageStats();
    const models = Object.keys(stats.byModel || {}).sort();

    if (models.length === 0) {
        return '<div style="text-align: center; opacity: 0.5; padding: 16px;">No models tracked yet</div>';
    }

    let html = '<div style="display: flex; flex-direction: column; gap: 6px;">';
    for (const model of models) {
        const prices = getModelPrice(model);
        const color = getModelColor(model);
        const shortName = model.length > 25 ? model.substring(0, 22) + '...' : model;

        html += `
            <div style="display: flex; align-items: center; gap: 8px;">
                <input type="color" value="${color}" data-model="${model}" class="model-color-input"
                    style="width: 24px; height: 24px; padding: 0; border: none; cursor: pointer; border-radius: 4px;">
                <span title="${model}" style="flex: 1; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${shortName}</span>
                <input type="number" class="model-price-in text_pole" data-model="${model}" value="${prices.in || ''}"
                    step="0.01" min="0" placeholder="In $" style="width: 70px; padding: 4px; font-size: 11px;">
                <input type="number" class="model-price-out text_pole" data-model="${model}" value="${prices.out || ''}"
                    step="0.01" min="0" placeholder="Out $" style="width: 70px; padding: 4px; font-size: 11px;">
            </div>
        `;
    }
    html += '</div>';
    return html;
}

/**
 * Export usage data as JSON
 */
function exportUsageData() {
    const settings = getSettings();
    const exportData = {
        exportDate: new Date().toISOString(),
        usage: settings.usage,
        modelPrices: settings.modelPrices,
        modelColors: settings.modelColors
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `token-usage-export-${getDayKey()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    // @ts-ignore
    toastr.success('Data exported');
}

/**
 * Import usage data from JSON file
 */
function importUsageData() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.onchange = async (e) => {
        const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
        if (!file) return;

        try {
            const text = await file.text();
            const importData = JSON.parse(text);

            // Validate the imported data structure
            if (!importData.usage) {
                // @ts-ignore
                toastr.error('Invalid import file: missing usage data');
                return;
            }

            const settings = getSettings();

            // Ask user how to handle the import
            const mergeChoice = confirm(
                'How would you like to import the data?\n\n' +
                'OK = Merge (add imported data to existing data)\n' +
                'Cancel = Replace (overwrite existing data with imported data)'
            );

            if (mergeChoice) {
                // Merge mode
                mergeUsageData(settings.usage, importData.usage);
            } else {
                // Replace mode
                settings.usage = importData.usage;
            }

            // Import model prices and colors
            if (importData.modelPrices) {
                for (const [modelId, prices] of Object.entries(importData.modelPrices)) {
                    if (!settings.modelPrices[modelId]) {
                        settings.modelPrices[modelId] = prices;
                    }
                }
            }
            if (importData.modelColors) {
                for (const [modelId, color] of Object.entries(importData.modelColors)) {
                    if (!settings.modelColors[modelId]) {
                        settings.modelColors[modelId] = color;
                    }
                }
            }

            saveSettings();
            eventSource.emit('tokenUsageUpdated', getUsageStats());

            // @ts-ignore
            toastr.success(`Data imported successfully (${mergeChoice ? 'merged' : 'replaced'})`);
            console.log('[Token Usage Tracker] Data imported from:', file.name);
        } catch (error) {
            console.error('[Token Usage Tracker] Import error:', error);
            // @ts-ignore
            toastr.error('Failed to import data: ' + error.message);
        }
    };

    input.click();
}

/**
 * Merge imported usage data into existing usage data
 * @param {Object} existing - Existing usage data
 * @param {Object} imported - Imported usage data
 */
function mergeUsageData(existing, imported) {
    // Merge allTime
    if (imported.allTime) {
        existing.allTime.input += imported.allTime.input || 0;
        existing.allTime.output += imported.allTime.output || 0;
        existing.allTime.total += imported.allTime.total || 0;
        existing.allTime.messageCount += imported.allTime.messageCount || 0;
    }

    // Merge time-based buckets
    const mergeBucket = (existingBucket, importedBucket) => {
        for (const [key, data] of Object.entries(importedBucket || {})) {
            if (!existingBucket[key]) {
                existingBucket[key] = { input: 0, output: 0, total: 0, messageCount: 0 };
            }
            existingBucket[key].input += data.input || 0;
            existingBucket[key].output += data.output || 0;
            existingBucket[key].total += data.total || 0;
            existingBucket[key].messageCount += data.messageCount || 0;

            // Merge models within day data
            if (data.models && existingBucket[key]) {
                if (!existingBucket[key].models) existingBucket[key].models = {};
                for (const [modelId, mData] of Object.entries(data.models)) {
                    if (!existingBucket[key].models[modelId]) {
                        existingBucket[key].models[modelId] = { input: 0, output: 0, total: 0 };
                    }
                    const existing = existingBucket[key].models[modelId];
                    if (typeof mData === 'number') {
                        existing.total += mData;
                    } else {
                        existing.input += mData.input || 0;
                        existing.output += mData.output || 0;
                        existing.total += mData.total || 0;
                    }
                }
            }
        }
    };

    mergeBucket(existing.byDay, imported.byDay);
    mergeBucket(existing.byHour, imported.byHour);
    mergeBucket(existing.byWeek, imported.byWeek);
    mergeBucket(existing.byMonth, imported.byMonth);
    mergeBucket(existing.byChat, imported.byChat);

    // Merge byModel
    for (const [modelId, data] of Object.entries(imported.byModel || {})) {
        if (!existing.byModel[modelId]) {
            existing.byModel[modelId] = { input: 0, output: 0, total: 0, messageCount: 0 };
        }
        existing.byModel[modelId].input += data.input || 0;
        existing.byModel[modelId].output += data.output || 0;
        existing.byModel[modelId].total += data.total || 0;
        existing.byModel[modelId].messageCount += data.messageCount || 0;
    }
}

/**
 * Check budget/threshold warnings
 */
function checkWarnings() {
    const settings = getSettings();
    const stats = getUsageStats();

    // Daily token warning
    if (settings.warningThreshold > 0 && stats.today.total >= settings.warningThreshold) {
        // @ts-ignore
        toastr.warning(`Daily token usage (${formatTokens(stats.today.total)}) has reached the warning threshold!`, 'Token Usage Warning');
    }

    // Monthly budget warning
    if (settings.budgetLimit > 0) {
        const now = new Date();
        const currentMonthKey = getMonthKey(now);
        let monthCost = 0;

        for (const [dayKey, data] of Object.entries(settings.usage.byDay)) {
            const [year, month, day] = dayKey.split('-').map(Number);
            const date = new Date(year, month - 1, day);

            if (getMonthKey(date) === currentMonthKey && data.models) {
                for (const [mid, mData] of Object.entries(data.models)) {
                    const mInput = typeof mData === 'number' ? 0 : (mData.input || 0);
                    const mOutput = typeof mData === 'number' ? 0 : (mData.output || 0);
                    monthCost += calculateCost(mInput, mOutput, mid);
                }
            }
        }

        if (monthCost >= settings.budgetLimit) {
            // @ts-ignore
            toastr.error(`Monthly budget limit ($${settings.budgetLimit.toFixed(2)}) has been reached! Current: $${monthCost.toFixed(2)}`, 'Budget Alert');
        } else if (monthCost >= settings.budgetLimit * 0.8) {
            // @ts-ignore
            toastr.warning(`Approaching monthly budget limit (80%). Current: $${monthCost.toFixed(2)} / $${settings.budgetLimit.toFixed(2)}`, 'Budget Warning');
        }
    }
}

// Chart state
let currentChartRange = 30;
let chartData = [];
let tooltip = null;

// Chart colors - adapted for dark theme
const CHART_COLORS = {
    bar: 'var(--SmartThemeBorderColor)',
    text: 'var(--SmartThemeBodyColor)',
    grid: 'var(--SmartThemeBorderColor)',
    cursor: 'var(--SmartThemeBodyColor)'
};

const SVG_NS = "http://www.w3.org/2000/svg";

function createSVGElement(type, attrs = {}) {
    const el = document.createElementNS(SVG_NS, type);
    for (const [key, value] of Object.entries(attrs)) {
        el.setAttribute(key, value);
    }
    return el;
}

/**
 * Get chart data from real usage stats
 */
function getChartData(days) {
    const stats = getUsageStats();
    const byDay = stats.byDay || {};
    const data = [];
    const today = new Date();

    for (let i = days - 1; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dayKey = getDayKey(date);
        const dayData = byDay[dayKey] || { total: 0, input: 0, output: 0, models: {} };

        data.push({
            date: date,
            dayKey: dayKey,
            usage: dayData.total || 0,
            input: dayData.input || 0,
            output: dayData.output || 0,
            models: dayData.models || {},
            displayDate: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date),
            fullDate: new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(date)
        });
    }
    return data;
}

/**
 * Render the bar chart
 */
function renderChart() {
    const container = document.getElementById('token-usage-chart');
    if (!container) return;

    container.innerHTML = '';
    const rect = container.getBoundingClientRect();
    const width = rect.width || 400;
    const height = rect.height || 200;

    if (width === 0 || height === 0) return;
    if (chartData.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: rgba(255,255,255,0.5); padding: 40px;">No usage data yet</div>';
        return;
    }

    const margin = { top: 10, right: 10, bottom: 25, left: 45 };
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;

    const svg = createSVGElement('svg', {
        width: width,
        height: height,
        viewBox: `0 0 ${width} ${height}`,
        style: 'display: block; max-width: 100%;'
    });


    const cursorGroup = createSVGElement('g', { class: 'cursors' });
    const gridGroup = createSVGElement('g', { class: 'grid' });
    const barGroup = createSVGElement('g', { class: 'bars' });
    const textGroup = createSVGElement('g', { class: 'labels' });

    svg.appendChild(cursorGroup);
    svg.appendChild(gridGroup);
    svg.appendChild(barGroup);
    svg.appendChild(textGroup);

    // Y Scale
    const maxUsage = Math.max(...chartData.map(d => d.usage), 1);
    const roughStep = maxUsage / 4;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep || 1)));
    let step = Math.ceil(roughStep / magnitude) * magnitude || 1000;

    if (step / magnitude < 1.5) step = 1 * magnitude;
    else if (step / magnitude < 3) step = 2.5 * magnitude;
    else if (step / magnitude < 7) step = 5 * magnitude;
    else step = 10 * magnitude;

    let niceMax = Math.ceil(maxUsage / step) * step;
    if (niceMax === 0) niceMax = 5000;

    const yScale = (val) => chartHeight - (val / niceMax) * chartHeight;

    // Grid and Y axis
    for (let val = 0; val <= niceMax; val += step) {
        const y = margin.top + yScale(val);

        const line = createSVGElement('line', {
            x1: margin.left,
            y1: y,
            x2: width - margin.right,
            y2: y,
            stroke: CHART_COLORS.grid,
            'stroke-width': '1',
            'stroke-dasharray': '4 4'
        });
        gridGroup.appendChild(line);

        const text = createSVGElement('text', {
            x: margin.left - 8,
            y: y + 4,
            'text-anchor': 'end',
            fill: CHART_COLORS.text,
            'font-size': '10',
            'font-family': 'ui-sans-serif, system-ui, sans-serif'
        });
        text.textContent = formatTokens(val);
        textGroup.appendChild(text);
    }

    // Bars
    const totalBarWidth = chartWidth / chartData.length;
    let barWidth = totalBarWidth * 0.8;
    if (barWidth > 40) barWidth = 40;
    const actualGap = totalBarWidth - barWidth;
    const labelInterval = currentChartRange === 90 ? 7 : currentChartRange === 30 ? 3 : 1;

    chartData.forEach((d, i) => {
        const slotX = margin.left + (i * totalBarWidth);
        const barX = slotX + (actualGap / 2);
        const barH = (d.usage / niceMax) * chartHeight;
        const barY = margin.top + (chartHeight - barH);

        // Hover area
        const cursor = createSVGElement('rect', {
            x: slotX,
            y: margin.top,
            width: totalBarWidth,
            height: chartHeight,
            fill: 'transparent',
            opacity: '0.1',
            class: 'cursor-rect',
            style: 'cursor: pointer;'
        });

        cursor.addEventListener('mouseenter', () => {
            cursor.setAttribute('fill', CHART_COLORS.cursor);
            showTooltip(d);
        });
        cursor.addEventListener('mousemove', (e) => {
            moveTooltip(e);
        });
        cursor.addEventListener('mouseleave', () => {
            cursor.setAttribute('fill', 'transparent');
            hideTooltip();
        });
        cursorGroup.appendChild(cursor);

        // Bar rendering - fill segments with model colors
        const r = Math.min(3, barWidth / 4);
        const h = Math.max(0, barH);
        const w = barWidth;

        // Build the outer bar path (with rounded top corners)
        let outerPathD;
        if (h < r * 2) {
            outerPathD = `M ${barX},${barY + h} v-${h} h${w} v${h} z`;
        } else {
            outerPathD = `M ${barX},${barY + h} v-${h - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`;
        }

        // Draw filled segments for each model
        if (d.models && Object.keys(d.models).length > 0 && d.usage > 0) {
            // Extract total from new object format or use number directly for legacy
            const getTokens = (v) => typeof v === 'number' ? v : (v.total || 0);
            const modelEntries = Object.entries(d.models).sort((a, b) => getTokens(b[1]) - getTokens(a[1])); // Sort by usage desc

            let cumulativeY = barY + h; // Start from bottom

            for (const [modelId, modelData] of modelEntries) {
                const tokens = getTokens(modelData);
                const segmentHeight = (tokens / d.usage) * h;
                const segmentY = cumulativeY - segmentHeight;

                // Create path for this segment with rounded corners for top segment
                let segmentPath;
                const isBottom = cumulativeY === barY + h;
                const isTop = segmentY <= barY + 0.01; // Small epsilon for float comparison

                if (segmentHeight < r * 2) {
                    // Too small for rounded corners
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight} h${w} v${segmentHeight} z`;
                } else if (isTop && isBottom) {
                    // Only segment - round top corners
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${segmentHeight - r} z`;
                } else if (isTop) {
                    // Top segment - round top corners only
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight - r} a${r},${r} 0 0 1 ${r},-${r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${segmentHeight - r} z`;
                } else {
                    // Bottom or middle segment - no rounding
                    segmentPath = `M ${barX},${cumulativeY} v-${segmentHeight} h${w} v${segmentHeight} z`;
                }

                const color = getModelColor(modelId);
                const segment = createSVGElement('path', {
                    d: segmentPath,
                    fill: color,
                    opacity: '1',
                    'shape-rendering': 'geometricPrecision',
                    'pointer-events': 'none'
                });
                barGroup.appendChild(segment);

                cumulativeY = segmentY;
            }
        }

        // Draw outer bar border (on top of segments)
        const outerPath = createSVGElement('path', {
            d: outerPathD,
            fill: 'none',
            stroke: CHART_COLORS.bar,
            'stroke-width': '1.5',
            'shape-rendering': 'geometricPrecision',
            'pointer-events': 'none'
        });
        barGroup.appendChild(outerPath);


        // X labels
        if (i % labelInterval === 0) {
            const label = createSVGElement('text', {
                x: barX + barWidth / 2,
                y: height - 5,
                'text-anchor': 'middle',
                fill: CHART_COLORS.text,
                opacity: '0.6',
                'font-size': '10',
                'font-family': 'ui-sans-serif, system-ui, sans-serif'
            });
            label.textContent = d.displayDate;
            textGroup.appendChild(label);
        }
    });

    container.appendChild(svg);
}

function showTooltip(d) {
    if (!tooltip) return;

    // Build model breakdown HTML
    let modelBreakdown = '';
    if (d.models && Object.keys(d.models).length > 0) {
        // Extract total from new object format or use number directly for legacy
        const getTokens = (v) => typeof v === 'number' ? v : (v.total || 0);
        const modelEntries = Object.entries(d.models).sort((a, b) => getTokens(a[1]) - getTokens(b[1])); // Sort ascending (smallest first, like graph bottom-up)
        modelBreakdown = '<div style="margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,0.2);">';
        const displayEntries = modelEntries.slice(-8); // Show last 8 (the largest)
        for (const [model, modelData] of displayEntries) {
            const tokens = getTokens(modelData);
            const percent = d.usage > 0 ? Math.round((tokens / d.usage) * 100) : 0;
            const shortName = model.length > 25 ? model.substring(0, 22) + '...' : model;
            const color = getModelColor(model);
            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.5); display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <div style="display: flex; align-items: center; gap: 4px; min-width: 0;">
                    <span style="display: inline-block; width: 8px; height: 8px; background: ${color}; border-radius: 2px; flex-shrink: 0;"></span>
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${shortName}</span>
                </div>
                <span style="flex-shrink: 0;">${formatTokens(tokens)} (${percent}%)</span>
            </div>`;
        }
        if (modelEntries.length > 8) {
            modelBreakdown += `<div style="font-size: 9px; color: rgba(255,255,255,0.3);">+${modelEntries.length - 8} more</div>`;
        }
        modelBreakdown += '</div>';
    }

    tooltip.innerHTML = `
        <div style="font-weight: 600; margin-bottom: 2px; color: var(--SmartThemeBodyColor);">${d.fullDate}</div>
        <div style="color: var(--SmartThemeBodyColor);">${formatNumberFull(d.usage)} tokens</div>
        <div style="font-size: 10px; color: var(--SmartThemeBodyColor); opacity: 0.6;">${formatNumberFull(d.input)} in / ${formatNumberFull(d.output)} out</div>
        ${modelBreakdown}
    `;
    tooltip.style.display = 'block';
}

function moveTooltip(e) {
    if (!tooltip) return;

    const tooltipWidth = tooltip.offsetWidth || 150;
    const tooltipHeight = tooltip.offsetHeight || 60;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = e.clientX + 15;
    let y = e.clientY - 10;

    // Keep tooltip within viewport
    if (x + tooltipWidth > viewportWidth - 10) {
        x = e.clientX - tooltipWidth - 15;
    }
    if (y + tooltipHeight > viewportHeight - 10) {
        y = viewportHeight - tooltipHeight - 10;
    }
    if (y < 10) {
        y = 10;
    }
    if (x < 10) {
        x = 10;
    }

    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
}

function hideTooltip() {
    if (!tooltip) return;
    tooltip.style.display = 'none';
}


function updateChartRange(range) {
    currentChartRange = range;
    chartData = getChartData(range);
    renderChart();

    document.querySelectorAll('.token-usage-range-btn').forEach(btn => {
        const val = parseInt(btn.getAttribute('data-value'));
        if (val === range) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

/**
 * Update the stats display in the UI
 */
function updateUIStats() {
    const stats = getUsageStats();
    const now = new Date();

    // Today header
    $('#token-usage-today-total').text(formatTokens(stats.today.total));
    $('#token-usage-today-in').text(formatTokens(stats.today.input || 0));
    $('#token-usage-today-out').text(formatTokens(stats.today.output || 0));

    // Stats grid
    $('#token-usage-week-total').text(formatTokens(stats.thisWeek.total));
    $('#token-usage-month-total').text(formatTokens(stats.thisMonth.total));
    $('#token-usage-alltime-total').text(formatTokens(stats.allTime.total));

    // Cost calculations
    const allTimeCost = calculateAllTimeCost();

    if (allTimeCost > 0) {
        $('#token-usage-alltime-cost').text(`$${allTimeCost.toFixed(2)}`);
    } else {
        $('#token-usage-alltime-cost').text('$0.00');
    }

    // For Week/Month: We iterate all `byDay` keys and match those that belong to current week/month
    const currentWeekKey = getWeekKey(now);
    const currentMonthKey = getMonthKey(now);
    const todayKey = getDayKey(now);

    let weekCost = 0;
    let monthCost = 0;
    let todayCost = 0;

    const settings = getSettings();
    for (const [dayKey, data] of Object.entries(settings.usage.byDay)) {
        // Parse dayKey (YYYY-MM-DD) as local date, not UTC
        // new Date("2026-01-01") interprets as UTC, which shifts timezone
        const [year, month, day] = dayKey.split('-').map(Number);
        const date = new Date(year, month - 1, day);

        // Week check
        if (getWeekKey(date) === currentWeekKey) {
            // Calculate cost for this day using per-model input/output breakdown
            if (data.models) {
                for (const [mid, modelData] of Object.entries(data.models)) {
                    // modelData is now { input, output, total } (or number for legacy data)
                    const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
                    const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
                    const cost = calculateCost(mInput, mOutput, mid);
                    weekCost += cost;
                    if (dayKey === todayKey) {
                        todayCost += cost;
                    }
                }
            }
        }
        // Month check
        if (getMonthKey(date) === currentMonthKey) {
             if (data.models) {
                 for (const [mid, modelData] of Object.entries(data.models)) {
                     const mInput = typeof modelData === 'number' ? 0 : (modelData.input || 0);
                     const mOutput = typeof modelData === 'number' ? 0 : (modelData.output || 0);
                     monthCost += calculateCost(mInput, mOutput, mid);
                 }
            }
        }
    }

    $('#token-usage-week-cost').text(`$${weekCost.toFixed(2)}`);
    $('#token-usage-month-cost').text(`$${monthCost.toFixed(2)}`);
    $('#token-usage-today-cost').text(`$${todayCost.toFixed(2)}`);

    $('#token-usage-tokenizer').text('Tokenizer: ' + (stats.tokenizer || 'Unknown'));

    // Update chart data
    chartData = getChartData(currentChartRange);
    renderChart();
}


/**
 * Create the settings UI in the extensions panel
 */
function createSettingsUI() {
    const settings = getSettings();
    const stats = getUsageStats();

    const html = `
        <div id="token_usage_tracker_container" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Token Usage Tracker</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <!-- Chart Header: Today stats + Range selector -->
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <div>
                            <div style="display: flex; align-items: baseline; gap: 6px;">
                                <span style="font-size: 18px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-today-total">${formatTokens(stats.today.total)}</span>
                                <span id="token-usage-today-cost" style="font-size: 12px; color: var(--SmartThemeBodyColor); opacity: 0.8;">$0.00</span>
                                <span style="font-size: 11px; color: var(--SmartThemeBodyColor); opacity: 0.5;"> today</span>
                            </div>
                            <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.4;">
                                <span id="token-usage-today-in">${formatTokens(stats.today.input || 0)}</span> in /
                                <span id="token-usage-today-out">${formatTokens(stats.today.output || 0)}</span> out
                            </div>
                        </div>
                        <div style="display: inline-flex; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 6px; padding: 2px;">
                            <button class="token-usage-range-btn menu_button" data-value="7" style="padding: 4px 10px; font-size: 11px; border-radius: 4px;">7D</button>
                            <button class="token-usage-range-btn menu_button active" data-value="30" style="padding: 4px 10px; font-size: 11px; border-radius: 4px;">30D</button>
                            <button class="token-usage-range-btn menu_button" data-value="90" style="padding: 4px 10px; font-size: 11px; border-radius: 4px;">90D</button>
                        </div>
                    </div>

                    <!-- Chart -->
                    <div id="token-usage-chart" style="width: 100%; height: 320px; background: var(--SmartThemeInputColor); border: 1px solid var(--SmartThemeBorderColor); border-radius: 8px; overflow: hidden; margin-bottom: 12px;"></div>

                    <!-- Stats Grid (Week, Month, All Time) -->
                    <div class="token-usage-stats-grid" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 10px;">
                        <div class="token-usage-stat-card" style="background: var(--SmartThemeInputColor); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); overflow: hidden; display: flex;">
                            <div style="flex: 1; padding: 4px 8px;">
                                <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">This Week</div>
                                <div style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-week-total">${formatTokens(stats.thisWeek.total)}</div>
                            </div>
                            <div style="width: 1px; background: var(--SmartThemeBorderColor);"></div>
                            <div style="flex: 1; padding: 4px 8px; display: flex; align-items: center; justify-content: center;">
                                <span style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-week-cost">$0.00</span>
                            </div>
                        </div>
                        <div class="token-usage-stat-card" style="background: var(--SmartThemeInputColor); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); overflow: hidden; display: flex;">
                            <div style="flex: 1; padding: 4px 8px;">
                                <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">This Month</div>
                                <div style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-month-total">${formatTokens(stats.thisMonth.total)}</div>
                            </div>
                            <div style="width: 1px; background: var(--SmartThemeBorderColor);"></div>
                            <div style="flex: 1; padding: 4px 8px; display: flex; align-items: center; justify-content: center;">
                                <span style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-month-cost">$0.00</span>
                            </div>
                        </div>
                        <div class="token-usage-stat-card" style="background: var(--SmartThemeInputColor); border-radius: 6px; border: 1px solid var(--SmartThemeBorderColor); overflow: hidden; display: flex;">
                            <div style="flex: 1; padding: 4px 8px;">
                                <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.5;">All Time</div>
                                <div style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-alltime-total">${formatTokens(stats.allTime.total)}</div>
                            </div>
                            <div style="width: 1px; background: var(--SmartThemeBorderColor);"></div>
                            <div style="flex: 1; padding: 4px 8px; display: flex; align-items: center; justify-content: center;">
                                <span style="font-size: 14px; font-weight: 600; color: var(--SmartThemeBodyColor);" id="token-usage-alltime-cost">$0.00</span>
                            </div>
                        </div>
                    </div>

                    <!-- Controls -->
                    <div style="display: flex; align-items: center; gap: 8px; padding-left: 8px; margin-top: 8px;">
                        <div style="font-size: 9px; color: var(--SmartThemeBodyColor); opacity: 0.4;" id="token-usage-tokenizer">Tokenizer: ${stats.tokenizer || 'Unknown'}</div>
                        <div style="flex: 1;"></div>
                        <div id="token-usage-detailed-stats" class="menu_button" title="View detailed statistics" style="color: var(--SmartThemeBodyColor); opacity: 0.8; font-size: 11px; white-space: nowrap;">
                            <i class="fa-solid fa-chart-pie"></i>&nbsp;Details
                        </div>
                        <div id="token-usage-settings" class="menu_button" title="Settings" style="color: var(--SmartThemeBodyColor); opacity: 0.8; font-size: 11px; white-space: nowrap;">
                            <i class="fa-solid fa-gear"></i>&nbsp;Settings
                        </div>
                        <div id="token-usage-reset-all" class="menu_button" title="Reset all stats" style="color: var(--SmartThemeBodyColor); opacity: 0.8; font-size: 11px; white-space: nowrap;">
                            <i class="fa-solid fa-trash"></i>&nbsp;Reset
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    const targetContainer = $('#extensions_settings2');
    if (targetContainer.length > 0) {
        targetContainer.append(html);
        console.log('[Token Usage Tracker] UI appended to extensions_settings2');
    } else {
        const fallback = $('#extensions_settings');
        if (fallback.length > 0) {
            fallback.append(html);
            console.log('[Token Usage Tracker] UI appended to extensions_settings (fallback)');
        }
    }

    // Create tooltip element and append to body (not inside extension container to avoid layout issues)
    if (!document.getElementById('token-usage-tooltip')) {
        const tooltipEl = document.createElement('div');
        tooltipEl.id = 'token-usage-tooltip';
        tooltipEl.style.cssText = 'position: fixed; display: none; background: rgba(0,0,0,0.9); color: white; padding: 8px 12px; border-radius: 6px; font-size: 11px; pointer-events: none; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.3);';
        document.body.appendChild(tooltipEl);
        console.log('[Token Usage Tracker] Tooltip appended to body');
    }
    tooltip = document.getElementById('token-usage-tooltip');

    // Initialize chart
    chartData = getChartData(currentChartRange);
    setTimeout(renderChart, 100);

    // Range button handlers
    document.querySelectorAll('.token-usage-range-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            updateChartRange(parseInt(btn.getAttribute('data-value')));
        });
    });

    $('#token-usage-reset-all').on('click', function() {
        if (confirm('Are you sure you want to reset ALL token usage data? This cannot be undone.')) {
            resetAllUsage();
            updateUIStats();
            // @ts-ignore - toastr is a global variable
            toastr.success('All stats reset');
        }
    });

    // Detailed stats popup handler
    $('#token-usage-detailed-stats').on('click', function() {
        showDetailedStatsPopup();
    });

    // Settings popup handler
    $('#token-usage-settings').on('click', function() {
        showSettingsPopup();
    });

    // Subscribe to updates
    eventSource.on('tokenUsageUpdated', updateUIStats);

    // Handle container resize with ResizeObserver (handles panel width changes)
    const chartContainer = document.getElementById('token-usage-chart');
    if (chartContainer && typeof ResizeObserver !== 'undefined') {
        let lastWidth = 0;
        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const newWidth = entry.contentRect.width;
                // Only re-render if width actually changed
                if (Math.abs(newWidth - lastWidth) > 5) {
                    lastWidth = newWidth;
                    renderChart();
                }
            }
        });
        resizeObserver.observe(chartContainer);
    }

    // Fallback: window resize
    let resizeTimeout;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(renderChart, 100);
    });
}

/**
 * Patch SillyTavern's background generation functions to track tokens
 * - generateQuiet / generate_quiet (Used by Summarize, generated prompts, etc.)
 * - ConnectionManagerRequestService.sendRequest (Used by extensions like Roadway)
 */
let isTrackingBackground = false;

function patchBackgroundGenerations() {
    patchGenerateQuietPrompt();
    patchConnectionManager();
}

function patchGenerateQuietPrompt() {
    // For quiet generations (Guided Generations, Summarize, Expressions, etc.),
    // MESSAGE_RECEIVED doesn't fire. Flush pending tokens on next generation or chat change.
    eventSource.on(event_types.GENERATION_STARTED, async (type, params, dryRun) => {
        if (dryRun) return;
        if (isQuietGeneration && pendingInputTokensPromise) {
            await flushQuietGeneration();
        }
    });

    eventSource.on(event_types.CHAT_CHANGED, async () => {
        if (isQuietGeneration && pendingInputTokensPromise) {
            await flushQuietGeneration();
        }
    });
}

/**
 * Flush a pending quiet generation, recording tokens from what we have
 */
async function flushQuietGeneration() {
    if (!pendingInputTokensPromise) return;

    try {
        const inputTokens = await pendingInputTokensPromise;
        const modelId = pendingModelId;

        // Try to get output from streaming processor
        let outputTokens = 0;
        if (streamingProcessor?.result) {
            outputTokens = await countTokens(streamingProcessor.result);
        }

        // Record the usage
        if (inputTokens > 0 || outputTokens > 0) {
            recordUsage(inputTokens, outputTokens, null, modelId);
        }
    } catch (e) {
        console.error('[Token Usage Tracker] Error flushing quiet generation:', e);
    } finally {
        // Reset state
        pendingInputTokensPromise = null;
        pendingModelId = null;
        isQuietGeneration = false;
    }
}

function patchConnectionManager() {
    // Poll for ConnectionManagerRequestService (used by Roadway and similar extensions)
    const checkInterval = setInterval(() => {
        try {
            const context = getContext();
            /** @type {any} */
            const ServiceClass = context?.ConnectionManagerRequestService;

            if (!ServiceClass || typeof ServiceClass.sendRequest !== 'function') return;
            if (ServiceClass.sendRequest._isPatched) {
                clearInterval(checkInterval);
                return;
            }

            const originalSendRequest = ServiceClass.sendRequest.bind(ServiceClass);

            ServiceClass.sendRequest = async function(profileId, messages, maxTokens, custom, overridePayload) {
                if (isTrackingBackground) {
                    return await originalSendRequest(profileId, messages, maxTokens, custom, overridePayload);
                }

                let inputTokens = 0;
                const modelId = getCurrentModelId();

                try {
                    isTrackingBackground = true;

                    try {
                        inputTokens = await countInputTokens({ prompt: messages });
                    } catch (e) {
                        console.error('[Token Usage Tracker] Error counting sendRequest input:', e);
                    }

                    /** @type {any} */
                    const result = await originalSendRequest(profileId, messages, maxTokens, custom, overridePayload);

                    try {
                        let outputTokens = 0;
                        if (result && typeof result.content === 'string') {
                            outputTokens = await countTokens(result.content);
                        } else if (typeof result === 'string') {
                            outputTokens = await countTokens(result);
                        }

                        if (outputTokens > 0 || inputTokens > 0) {
                            recordUsage(inputTokens, outputTokens, null, modelId);
                        }
                    } catch (e) {
                        console.error('[Token Usage Tracker] Error counting sendRequest output:', e);
                    }

                    return result;
                } finally {
                    isTrackingBackground = false;
                }
            };

            ServiceClass.sendRequest._isPatched = true;
            clearInterval(checkInterval);
        } catch (e) {
            console.error('[Token Usage Tracker] Error in patchConnectionManager:', e);
        }
    }, 1000);

    // Stop polling after 30 seconds
    setTimeout(() => clearInterval(checkInterval), 30000);
}

/**
 * Generic handler for background generations with recursion guard
 */
async function handleBackgroundGeneration(originalFn, context, args, inputCounter, outputCounter) {
    // Avoid double counting if one patched function calls another
    if (isTrackingBackground) {
        return await originalFn.apply(context, args);
    }

    let result;
    let inputTokens = 0;
    const modelId = getCurrentModelId();

    try {
        isTrackingBackground = true;

        // Count input tokens
        try {
            inputTokens = await inputCounter();
            console.log(`[Token Usage Tracker] Counting background input. Tokens: ${inputTokens}`);
        } catch (e) {
            console.error('[Token Usage Tracker] Error counting background input:', e);
        }

        // Execute original
        result = await originalFn.apply(context, args);

        // Count output tokens
        try {
            const outputTokens = await outputCounter(result);
            if (outputTokens > 0 || inputTokens > 0) {
                recordUsage(inputTokens, outputTokens, null, modelId);
                console.log(`[Token Usage Tracker] Background usage recorded: ${inputTokens} in, ${outputTokens} out`);
            }
        } catch (e) {
            console.error('[Token Usage Tracker] Error counting background output:', e);
        }
    } finally {
        isTrackingBackground = false;
    }

    return result;
}

jQuery(async () => {
    console.log('[Token Usage Tracker] Initializing...');

    loadSettings();
    registerSlashCommands();
    createSettingsUI();

    // Attempt to patch background generation functions
    patchBackgroundGenerations();

    // Subscribe to events
    eventSource.on(event_types.GENERATION_STARTED, handleGenerationStarted);
    eventSource.on(event_types.GENERATE_AFTER_DATA, handleGenerateAfterData);
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);
    eventSource.on(event_types.GENERATION_STOPPED, handleGenerationStopped);
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
    eventSource.on(event_types.IMPERSONATE_READY, handleImpersonateReady);

    // Log current tokenizer
    try {
        const { tokenizerName } = getFriendlyTokenizerName(main_api);
        console.log(`[Token Usage Tracker] Using tokenizer: ${tokenizerName}`);
    } catch (e) {
        console.log('[Token Usage Tracker] Tokenizer will be determined when API is connected');
    }

    console.log('[Token Usage Tracker] Use /tokenusage to see stats, /tokenreset to reset session');

    // Emit initial stats for any listening UI
    setTimeout(() => {
        eventSource.emit('tokenUsageUpdated', getUsageStats());
    }, 1000);
});
