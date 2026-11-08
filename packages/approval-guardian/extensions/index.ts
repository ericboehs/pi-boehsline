// pi-lens-ignore: find-import-file-without-extension
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import {
	collectGuardianMessages,
	DIRECT_USER_INPUT_ENTRY_TYPE,
	DirectUserInputTracker,
} from "../src/authorization-provenance.ts";
import { loadGuardianConfig, type GuardianConfig } from "../src/config.ts";
import { DirectoryScanCache } from "../src/directory-scan-cache.ts";
import {
	DenialCircuitBreaker,
	ReviewBatchTracker,
	circuitOutcomeForReview,
	type GuardianReviewResult,
} from "../src/gate.ts";
import {
	buildGuardianSystemPrompt,
	buildPrivateDataReviewSystemPrompt,
} from "../src/policy.ts";
import {
	formatReviewResult,
	rejectionReason,
	reviewResultDiagnostic,
} from "../src/review-presentation.ts";
import {
	showGuardianConfiguration,
	syncGuardianRuntimeHealth,
} from "../src/guardian-status.ts";
import type { GuardianAction } from "../src/review.ts";
import {
	buildReviewerChannels,
	modelSpecFor,
	reviewerChannelLabel,
	runReviewWithFallbackChain,
	shouldFallbackReview,
	type ReviewerChannel,
} from "../src/reviewer-channels.ts";
import { ReviewerSessionController } from "../src/reviewer-session.ts";
import {
	actionFromToolCall,
	enforceActionRequirements,
	reviewerToolsForAction,
	shouldInvalidateDirectoryScanCache,
	toolCallBatchInfo,
} from "../src/tool-actions.ts";
import { openGuardianSettings } from "../src/settings-menu.ts";
import { lockAllowedToolInput } from "../src/tool-input-lock.ts";

export {
	guardianHealth,
	runReviewWithFallbackChain,
	shouldFallbackReview,
	type ReviewerChannel,
} from "../src/reviewer-channels.ts";
export {
	actionFromToolCall,
	enforceActionRequirements,
	reviewerToolsForAction,
	shouldInvalidateDirectoryScanCache,
	toolCallBatchInfo,
} from "../src/tool-actions.ts";
export {
	lockAllowedToolInput,
	lockReviewedToolInput,
} from "../src/tool-input-lock.ts";

export interface ApprovalGuardianOptions {
	directoryScanCache?: DirectoryScanCache;
}

export const APPROVAL_GUARDIAN_BYPASS_CONTROL_EVENT =
	"approval-guardian:set-temporary-bypass";
export const APPROVAL_GUARDIAN_BYPASS_STATE_EVENT =
	"approval-guardian:temporary-bypass-state";

/**
 * Process-scoped carrier for temporary bypass across `/reload`.
 *
 * `/reload` copies `ExtensionRunner` flag values into the new runtime, but
 * `ExtensionAPI` can only read flags. Registering a CLI flag would also show
 * up in `--help` and could start a non-TUI process already bypassed. This
 * slot has the same lifetime as those copied flag values: the process keeps
 * it, and session replacement or exit drops it. Module state cannot do this
 * because Pi re-imports the extension with the module cache disabled.
 */
const TEMPORARY_BYPASS_PROCESS_SLOT = Symbol.for(
	"pi-approval-guardian.temporary-bypass",
);

/** A session entry recording each bypass change, so a resumed session knows it ended bypassed. */
export const BYPASS_STATE_ENTRY_TYPE = "approval-guardian-bypass-state";
export const BYPASS_AGAIN_COMMAND = "/approval-guardian bypass";

/** Whether the branch's last bypass change turned it on: the session ended bypassed. */
export function bypassedWhenLeft(entries: readonly unknown[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as
			| { type?: string; customType?: string; data?: { active?: unknown } }
			| undefined;
		if (entry?.type === "custom" && entry.customType === BYPASS_STATE_ENTRY_TYPE) {
			return entry.data?.active === true;
		}
	}
	return false;
}

function sessionFileOf(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getSessionFile?.();
}

function persistedBypassSessionFile(): string | undefined | null {
	const value = Reflect.get(globalThis, TEMPORARY_BYPASS_PROCESS_SLOT);
	if (!value || typeof value !== "object") return null;
	const sessionFile = (value as { sessionFile?: unknown }).sessionFile;
	if (sessionFile === undefined) return undefined;
	return typeof sessionFile === "string" ? sessionFile : null;
}

function persistTemporaryBypass(
	active: boolean,
	sessionFile?: string,
): void {
	if (active) {
		Reflect.set(globalThis, TEMPORARY_BYPASS_PROCESS_SLOT, { sessionFile });
		return;
	}
	Reflect.deleteProperty(globalThis, TEMPORARY_BYPASS_PROCESS_SLOT);
}

export interface ApprovalGuardianBypassControlRequest {
	active: boolean;
	handled?: boolean;
	/**
	 * Skip the multi-line "temporarily BYPASSED" notice. For callers that
	 * already render the bypass state persistently themselves (e.g. a footer
	 * chip), where the warning would repeat what the caller just displayed.
	 * The below-editor widget still renders, so a caller that goes quiet must
	 * keep the state visible somewhere.
	 */
	quiet?: boolean;
}

// Extension wiring intentionally coordinates lifecycle, UI, policy, and reviewer state.
// pi-lens-ignore: high-complexity, high-fan-out
export default function approvalGuardian(
	pi: ExtensionAPI,
	options: ApprovalGuardianOptions = {},
) {
	let temporaryBypassActive = false;
	let runtimeContext: ExtensionContext | undefined;
	let configurationWarningKey: string | undefined;
	const reviewerSwitchNoticeKeys = new Set<string>();
	const controllers = new Map<string, ReviewerSessionController>();
	let controllerContextKey: string | undefined;
	const circuitBreaker = new DenialCircuitBreaker();
	const reviewBatches = new ReviewBatchTracker();
	const directoryScanCache =
		options.directoryScanCache ?? new DirectoryScanCache();
	const directUserInputTracker = new DirectUserInputTracker();

	const showBypassWarning = (ctx: ExtensionContext) => {
		ctx.ui.setWidget(
			"approval-guardian-bypass",
			[
				ctx.ui.theme.fg(
					"warning",
					"⚠ Approval Guardian is BYPASSED — run /approval-guardian enable",
				),
			],
			{ placement: "belowEditor" },
		);
	};

	const clearBypassWarning = (ctx: ExtensionContext) => {
		ctx.ui.setWidget("approval-guardian-bypass", undefined);
	};

	const disposeReviewerControllers = () => {
		for (const controller of controllers.values()) controller.dispose();
		controllers.clear();
		controllerContextKey = undefined;
	};

	const resetRuntime = () => {
		disposeReviewerControllers();
		temporaryBypassActive = false;
		configurationWarningKey = undefined;
		reviewerSwitchNoticeKeys.clear();
		circuitBreaker.reset();
		reviewBatches.reset();
		directoryScanCache.clear();
		directUserInputTracker.reset();
	};

	const syncConfigurationWarnings = (
		ctx: ExtensionContext,
		warnings: string[],
	) => {
		const nextKey = warnings.length > 0 ? warnings.join("\n") : undefined;
		if (!nextKey) {
			configurationWarningKey = undefined;
			return;
		}
		if (configurationWarningKey === nextKey) return;
		configurationWarningKey = nextKey;
		ctx.ui.notify(
			[
				"Approval Guardian configuration warning. Invalid entries were ignored; remaining valid settings and built-in defaults are active.",
				...warnings,
			].join("\n"),
			"warning",
		);
	};

	const notifyReviewerSwitch = (
		ctx: ExtensionContext,
		from: ReviewerChannel,
		to: ReviewerChannel,
	) => {
		const key = `${from.role}:${from.modelSpec}→${to.role}:${to.modelSpec}`;
		if (reviewerSwitchNoticeKeys.has(key)) return;
		reviewerSwitchNoticeKeys.add(key);
		ctx.ui.notify(
			to.role === "current-model"
				? `Guardian · configured reviewer channels unavailable; using current session model ${to.modelSpec}.`
				: `Guardian · primary reviewer unavailable; using configured fallback ${to.modelSpec}.`,
			"warning",
		);
	};

	const finishReviewBatch = (batchId: string, ctx: ExtensionContext) => {
		const adverse = reviewBatches.finish(batchId);
		if (adverse !== undefined && circuitBreaker.record(adverse)) ctx.abort();
	};

	const statusCallbacks = {
		syncConfigurationWarnings,
		notifyReviewerSwitch,
	};

	const restoreTemporaryBypassAfterReload = (ctx: ExtensionContext) => {
		const persistedSessionFile = persistedBypassSessionFile();
		if (persistedSessionFile === null) return;
		// A different session file means /new, /resume, or /fork, even if the
		// shutdown clear was skipped. Leave the slot for the session that owns it.
		// Undefined matches only an in-memory session.
		if (persistedSessionFile !== sessionFileOf(ctx)) return;
		// Fail closed when the new runtime cannot keep the warning on screen.
		if (ctx.mode !== "tui") {
			persistTemporaryBypass(false);
			return;
		}
		temporaryBypassActive = true;
		showBypassWarning(ctx);
		pi.events?.emit(APPROVAL_GUARDIAN_BYPASS_STATE_EVENT, {
			active: true,
		});
	};

	// A resumed session that ended bypassed gets the bypass command typed into its editor, never
	// run: turning the bypass back on still takes the user's Enter. An editor already holding text
	// is left alone.
	const offerBypassAgain = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		if (!bypassedWhenLeft(ctx.sessionManager.getBranch?.() ?? [])) return;
		if ((ctx.ui.getEditorText?.() ?? "").trim() !== "") return;
		ctx.ui.setEditorText?.(BYPASS_AGAIN_COMMAND);
		ctx.ui.notify(
			"This session had Approval Guardian bypassed when it ended. The bypass is off now; press Enter to turn it back on.",
			"warning",
		);
	};

	pi.on("session_start", (event: SessionStartEvent, ctx) => {
		runtimeContext = ctx;
		const wasBypassed = temporaryBypassActive;
		resetRuntime();
		if (wasBypassed) clearBypassWarning(ctx);
		// Only /reload replaces this runtime inside the same process. /new,
		// /resume, /fork, and startup must not inherit a bypass from the slot.
		if (event.reason === "reload") restoreTemporaryBypassAfterReload(ctx);
		else if (wasBypassed) persistTemporaryBypass(false);
		if (event.reason === "resume" || event.reason === "startup") offerBypassAgain(ctx);
		syncGuardianRuntimeHealth(ctx, statusCallbacks);
	});
	pi.on("session_shutdown", (event: SessionShutdownEvent, ctx) => {
		const persistedSessionFile = persistedBypassSessionFile();
		if (
			event?.reason !== "reload" &&
			(temporaryBypassActive ||
				persistedSessionFile === null ||
				persistedSessionFile === sessionFileOf(ctx))
		) {
			persistTemporaryBypass(false);
		}
		resetRuntime();
		clearBypassWarning(ctx);
		runtimeContext = undefined;
	});
	pi.on("input", (event) => {
		directUserInputTracker.observe(event);
	});
	pi.on("before_agent_start", (event) => {
		directUserInputTracker.confirmPrompt(event.prompt);
		// Temporary bypass is intentionally UI/control-plane state only. Do not
		// inject it into model context or treat it as additional authorization.
		circuitBreaker.reset();
		reviewBatches.reset();
		directoryScanCache.clear();
	});
	pi.on("message_start", (event) => {
		if (event.message.role !== "user") return;
		const record = directUserInputTracker.recordForMessage(event.message);
		if (record) pi.appendEntry(DIRECT_USER_INPUT_ENTRY_TYPE, record);
	});

	const setTemporaryBypass = (
		nextActive: boolean,
		ctx: ExtensionContext,
		options: { quiet?: boolean } = {},
	): void => {
		if (nextActive && ctx.mode !== "tui") {
			throw new Error(
				"Temporary Approval Guardian bypass requires interactive TUI mode so the persistent warning remains visible.",
			);
		}
		if (temporaryBypassActive === nextActive) {
			if (nextActive || persistedBypassSessionFile() === sessionFileOf(ctx)) {
				persistTemporaryBypass(nextActive, sessionFileOf(ctx));
			}
			if (nextActive) showBypassWarning(ctx);
			else clearBypassWarning(ctx);
			pi.events?.emit(APPROVAL_GUARDIAN_BYPASS_STATE_EVENT, {
				active: temporaryBypassActive,
			});
			ctx.ui.notify(
				nextActive
					? "Approval Guardian is already temporarily bypassed. Run /approval-guardian enable to restore protection."
					: "Approval Guardian is already enabled.",
				nextActive ? "warning" : "info",
			);
			return;
		}

		temporaryBypassActive = nextActive;
		persistTemporaryBypass(nextActive, sessionFileOf(ctx));
		pi.appendEntry?.(BYPASS_STATE_ENTRY_TYPE, { active: nextActive });
		disposeReviewerControllers();
		reviewerSwitchNoticeKeys.clear();
		circuitBreaker.reset();
		reviewBatches.reset();
		directoryScanCache.clear();
		if (nextActive) {
			showBypassWarning(ctx);
			pi.events?.emit(APPROVAL_GUARDIAN_BYPASS_STATE_EVENT, {
				active: temporaryBypassActive,
			});
			if (!options.quiet) {
				ctx.ui.notify(
					[
						"Approval Guardian is temporarily BYPASSED.",
						"Covered agent tool calls will proceed without Guardian review until /approval-guardian enable.",
						"This does not grant the agent additional authorization. The bypass stays on across /reload and resets when the session is replaced or Pi restarts.",
					].join("\n"),
					"warning",
				);
			}
			return;
		}

		clearBypassWarning(ctx);
		pi.events?.emit(APPROVAL_GUARDIAN_BYPASS_STATE_EVENT, {
			active: temporaryBypassActive,
		});
		syncGuardianRuntimeHealth(ctx, statusCallbacks);
		ctx.ui.notify(
			"Approval Guardian is enabled again. Covered agent tool calls once again require Guardian review.",
			"info",
		);
	};

	pi.events?.on(APPROVAL_GUARDIAN_BYPASS_CONTROL_EVENT, (data: unknown) => {
		if (!data || typeof data !== "object" || !runtimeContext) return;
		const request = data as Partial<ApprovalGuardianBypassControlRequest>;
		if (typeof request.active !== "boolean") return;
		setTemporaryBypass(request.active, runtimeContext, { quiet: request.quiet === true });
		request.handled = true;
	});

	const commandArguments = [
		{
			value: "status",
			label: "status",
			description: "Show reviewer readiness and configuration",
		},
		{
			value: "rules",
			label: "rules",
			description: "Show review levels",
		},
		{
			value: "bypass",
			label: "bypass",
			description: "Temporarily disable Guardian review",
		},
		{
			value: "enable",
			label: "enable",
			description: "End the temporary bypass",
		},
	];

	pi.registerCommand("approval-guardian", {
		description:
			"Configure Guardian settings, show status/rules, or temporarily bypass/enable review",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const matches = commandArguments.filter(({ value }) =>
				value.startsWith(normalized),
			);
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const subcommand = args.trim().toLowerCase();
			if (subcommand === "bypass" || subcommand === "enable") {
				await setTemporaryBypass(subcommand === "bypass", ctx);
				return;
			}
			if (subcommand === "" && ctx.mode === "tui") {
				await openGuardianSettings(ctx, {
					isBypassed: () => temporaryBypassActive,
					setBypass: (active, commandCtx) =>
						setTemporaryBypass(active, commandCtx),
					showStatus: (commandCtx) =>
						showGuardianConfiguration(
							"",
							commandCtx,
							temporaryBypassActive,
							statusCallbacks,
						),
				});
				return;
			}
			await showGuardianConfiguration(
				subcommand === "status" ? "" : args,
				ctx,
				temporaryBypassActive,
				statusCallbacks,
			);
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (temporaryBypassActive) return;
		const batch = toolCallBatchInfo(
			event.toolCallId,
			ctx.sessionManager.getBranch(),
		);
		try {
			const config = loadGuardianConfig({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
			});
			syncConfigurationWarnings(ctx, config.warnings);
			const action = actionFromToolCall(
				event,
				ctx.cwd,
				config.review,
				directoryScanCache,
			);
			if (!action) return;

			if (circuitBreaker.isOpen()) {
				const result: GuardianReviewResult = {
					kind: "circuit-open",
					message: "Repeated adverse Guardian outcomes reached the per-turn limit.",
				};
				ctx.ui.notify(formatReviewResult(result, action), "error");
				return { block: true, reason: rejectionReason(result) };
			}

			const reviewed = await reviewAction(action, config, ctx);
			// Bypass may be activated while reviewer inference is in flight. The
			// mode transition disposes the reviewer; this second check ensures its
			// cancellation does not fail closed after the user has enabled bypass.
			if (temporaryBypassActive) return;
			const result = lockAllowedToolInput(
				event,
				enforceActionRequirements(action, reviewed),
			);
			const circuitOutcome = circuitOutcomeForReview(result);
			if (circuitOutcome !== undefined) {
				reviewBatches.record(batch.id, circuitOutcome);
			}
			if (result.kind === "allowed") {
				ctx.ui.notify(formatReviewResult(result, action), "info");
				return;
			}

			if (result.kind === "denied") {
				ctx.ui.notify(formatReviewResult(result, action), "error");
			} else {
				ctx.ui.notify(
					formatReviewResult(result, action),
					result.kind === "cancelled" ? "warning" : "error",
				);
			}
			return { block: true, reason: rejectionReason(result) };
		} finally {
			if (batch.isLast) finishReviewBatch(batch.id, ctx);
		}
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (temporaryBypassActive) return;
		if (shouldInvalidateDirectoryScanCache(event.toolName)) {
			directoryScanCache.clear();
		}
		const batch = toolCallBatchInfo(
			event.toolCallId,
			ctx.sessionManager.getBranch(),
		);
		if (batch.isLast) finishReviewBatch(batch.id, ctx);
	});

	async function reviewAction(
		action: GuardianAction,
		config: GuardianConfig,
		ctx: ExtensionContext,
	): Promise<GuardianReviewResult> {
		try {
			const channels = buildReviewerChannels(
				config,
				ctx.modelRegistry,
				ctx.model,
			);
			const { result, attempts } = await runReviewWithFallbackChain(
				channels,
				(channel) => reviewWithChannel(channel, config, action, ctx),
				(from, to) => notifyReviewerSwitch(ctx, from, to),
			);
			const usedFallback = attempts.length > 1;
			if (usedFallback && shouldFallbackReview(result)) {
				ctx.ui.notify(
					[
						"Guardian · all attempted reviewer channels failed.",
						...attempts.map(
							({ channel, result: attemptResult }) =>
								`${reviewerChannelLabel(channel.role)} (${channel.modelSpec}): ${reviewResultDiagnostic(attemptResult)}`,
						),
					].join("\n"),
					"error",
				);
			}
			if (
				!usedFallback &&
				(result.kind === "allowed" || result.kind === "denied")
			) {
				reviewerSwitchNoticeKeys.clear();
			}
			if (usedFallback && result.kind === "failure") {
				return {
					kind: "failure",
					message: "Automatic approval review failed.",
				};
			}
			if (usedFallback && result.kind === "timeout") {
				return {
					kind: "timeout",
					message: "Automatic approval review timed out.",
				};
			}
			return result;
		} catch (error) {
			return {
				kind: "failure",
				message: `Automatic approval review failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	async function reviewWithChannel(
		channel: ReviewerChannel,
		config: GuardianConfig,
		action: GuardianAction,
		ctx: ExtensionContext,
	): Promise<GuardianReviewResult> {
		try {
			const model = channel.model;
			if (!model) {
				return {
					kind: "failure",
					message: `Reviewer model not found: ${channel.modelSpec}.`,
				};
			}
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				return {
					kind: "failure",
					message: `Reviewer authentication is unavailable for ${model.provider}.`,
				};
			}

			const privateDataReview = action.payload.private_data_read === true;
			const baseSystemPrompt = buildGuardianSystemPrompt(config.policy);
			const systemPrompt = privateDataReview
				? buildPrivateDataReviewSystemPrompt(baseSystemPrompt)
				: baseSystemPrompt;
			const reviewerTools = reviewerToolsForAction(action);
			const nextContextKey = JSON.stringify({
				cwd: ctx.cwd,
				primaryModel: config.model,
				fallbackModel: config.fallbackModel,
				currentModel: ctx.model ? modelSpecFor(ctx.model) : undefined,
				timeoutMs: config.timeoutMs,
				baseSystemPrompt,
			});
			if (controllerContextKey !== nextContextKey) {
				for (const existing of controllers.values()) existing.dispose();
				controllers.clear();
				controllerContextKey = nextContextKey;
			}
			const key = JSON.stringify({
				channel: channel.role,
				modelSpec: channel.modelSpec,
				model: `${model.provider}/${model.id}`,
				privateDataReview,
			});
			let controller = controllers.get(key);
			if (!controller) {
				controller = new ReviewerSessionController({
					model,
					modelRegistry: ctx.modelRegistry,
					cwd: ctx.cwd,
					systemPrompt,
					timeoutMs: config.timeoutMs,
					tools: reviewerTools,
				});
				controllers.set(key, controller);
			}
			return controller.review(
				action,
				collectGuardianMessages(ctx.sessionManager.getBranch()),
				ctx.signal,
			);
		} catch (error) {
			return {
				kind: "failure",
				message: `Automatic approval review failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
}
