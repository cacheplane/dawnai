import assert from "node:assert/strict";
import test from "node:test";

import {
	assertFreshWriterAuthority,
	captureConsolidationAuthority,
	captureNpmInventory,
} from "../duplicate-draft-consolidation-authority.mjs";
import { inspectEquivalentDrafts } from "../duplicate-draft-consolidation-evidence.mjs";
import { createConsolidationEnvelope } from "../duplicate-draft-consolidation-schema.mjs";
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs";
import {
	createDuplicateDraftConsolidationFixture,
	DUPLICATE_DRAFT_CANDIDATE,
	DUPLICATE_DRAFT_IDS,
	DUPLICATE_DRAFT_SURVIVOR_ID,
} from "./support/duplicate-draft-consolidation-fixture.mjs";

const REPOSITORY_ID = "1210070282";
const ACTOR = Object.freeze({ login: "blove", id: "61436" });
const TAG_OBJECT_SHA = "a".repeat(40);
const WORKFLOW_ID = "202458345";
const BASE_TIME = Date.parse("2026-09-01T12:00:00.000Z");
const EXACT_WORKFLOW_RUN_QUERY = Object.freeze({
	statuses: Object.freeze([
		"in_progress",
		"pending",
		"queued",
		"requested",
		"waiting",
	]),
	perPage: 100,
	maximumPages: 100,
});

test("captures exact pre-delete authority and leaves direct GET plus asset enumeration terminal", async () => {
	const fixture = await authorityFixture();
	const captured = await captureConsolidationAuthority(fixture.input);

	assert.deepEqual(
		captured.authority.releases.map(({ role, id }) => ({ role, id })),
		[
			{ role: "survivor", id: DUPLICATE_DRAFT_SURVIVOR_ID },
			{ role: "duplicate", id: DUPLICATE_DRAFT_IDS[0] },
			{ role: "duplicate", id: DUPLICATE_DRAFT_IDS[1] },
		],
	);
	assert.equal(captured.authority.stage, "pre-delete-1");
	assert.equal(
		captured.authority.targetRead.evidence.id,
		DUPLICATE_DRAFT_IDS[0],
	);
	assert.deepEqual(fixture.networkOperations.slice(-2), [
		`get-release:${DUPLICATE_DRAFT_IDS[0]}`,
		`list-assets:${DUPLICATE_DRAFT_IDS[0]}`,
	]);
	assert.equal(
		fixture.networkOperations.filter((entry) => entry.startsWith("download:"))
			.length,
		135,
	);
	assert.equal(Object.isFrozen(captured.authority), true);
	assert.equal(Object.isFrozen(captured.authority.releases[0].assets), true);
	assert.equal(Object.isSealed(captured.networkEpoch), true);
	assert.deepEqual(Object.keys(captured.networkEpoch), []);
	assert.equal(JSON.stringify(captured).includes("networkEpoch"), false);
	assert.equal(JSON.stringify(captured.authority).includes("consume"), false);
	assert.throws(
		() => JSON.stringify(captured.networkEpoch),
		/serialize|capability|epoch/iu,
	);

	let writes = 0;
	const result = await captured.networkEpoch.consume({
		authority: captured.authority,
		proposal: fixture.proposal,
		targetReleaseId: DUPLICATE_DRAFT_IDS[0],
		now: new Date(fixture.nowMs).toISOString(),
		writeIntent: async () => {
			writes += 1;
			return "written";
		},
	});
	assert.equal(result, "written");
	assert.equal(writes, 1);
	await assert.rejects(
		captured.networkEpoch.consume({
			authority: captured.authority,
			proposal: fixture.proposal,
			targetReleaseId: DUPLICATE_DRAFT_IDS[0],
			now: new Date(fixture.nowMs).toISOString(),
			writeIntent: async () => "again",
		}),
		/consumed|epoch/iu,
	);
});

test("invalidates the one-use epoch after any intervening adapter read", async () => {
	const fixture = await authorityFixture();
	const captured = await captureConsolidationAuthority(fixture.input);
	fixture.incrementNetworkRead();

	await assert.rejects(
		captured.networkEpoch.consume({
			authority: captured.authority,
			proposal: fixture.proposal,
			targetReleaseId: DUPLICATE_DRAFT_IDS[0],
			now: new Date(fixture.nowMs).toISOString(),
			writeIntent: async () => assert.fail("stale epoch must not write"),
		}),
		/epoch|intervening|read/iu,
	);
});

test("fails capture if the adapter counter advances after terminal completion but before return", async () => {
	const fixture = await authorityFixture();
	const currentCount = fixture.input.networkReadCount;
	let samples = 0;
	fixture.input.networkReadCount = () => {
		const value = currentCount();
		samples += 1;
		if (samples === 1) fixture.incrementNetworkRead();
		return value;
	};

	await assert.rejects(
		captureConsolidationAuthority(fixture.input),
		/epoch|intervening|read|terminal/iu,
	);
});

test("binds the frozen exact workflow-run query to the executed adapter read", async () => {
	const fixture = await authorityFixture();
	const github = fixture.input.github;
	let receivedQuery;
	fixture.input.github = Object.freeze({
		...github,
		async listNonterminalWorkflowRuns(query) {
			receivedQuery = query;
			assert.equal(Object.isFrozen(query), true);
			assert.equal(Object.isFrozen(query.statuses), true);
			return {
				query: structuredClone(query),
				runs: await github.listNonterminalWorkflowRuns(query),
			};
		},
	});

	const captured = await captureConsolidationAuthority(fixture.input);
	assert.deepEqual(receivedQuery, EXACT_WORKFLOW_RUN_QUERY);
	assert.notEqual(receivedQuery, EXACT_WORKFLOW_RUN_QUERY);
	assert.deepEqual(
		captured.authority.workflowAuthority.query,
		EXACT_WORKFLOW_RUN_QUERY,
	);
});

test("rejects an adapter echo that drifts the executed workflow-run query", async (t) => {
	for (const [name, mutate] of [
		["incomplete statuses", (query) => query.statuses.pop()],
		["status order", (query) => query.statuses.reverse()],
		["per-page bound", (query) => (query.perPage = 99)],
		["maximum-pages bound", (query) => (query.maximumPages = 99)],
	]) {
		await t.test(name, async () => {
			const fixture = await authorityFixture();
			const github = fixture.input.github;
			fixture.input.github = Object.freeze({
				...github,
				async listNonterminalWorkflowRuns(query) {
					const echoedQuery = structuredClone(query);
					mutate(echoedQuery);
					return {
						query: echoedQuery,
						runs: await github.listNonterminalWorkflowRuns(query),
					};
				},
			});

			await assert.rejects(
				captureConsolidationAuthority(fixture.input),
				/query|workflow|status|page|bound/iu,
			);
		});
	}
});

test("captures exact ordered npm absence evidence with bounded canonical timestamps", async () => {
	let nowMs = BASE_TIME;
	const calls = [];
	const inventory = await captureNpmInventory({
		stage: "pre-delete-1",
		candidate: DUPLICATE_DRAFT_CANDIDATE,
		npm: Object.freeze({
			async observePackageVersion(input) {
				calls.push(structuredClone(input));
				nowMs += 1;
				return {
					status: "ABSENT",
					operation: "package-version",
					httpStatus: 404,
					code: "E404",
				};
			},
		}),
		now: () => new Date(nowMs).toISOString(),
	});

	assert.deepEqual(
		inventory.packages.map(({ name }) => name),
		CANONICAL_RELEASE_PACKAGE_ORDER,
	);
	assert.deepEqual(
		calls,
		CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => ({
			name,
			version: "0.8.22",
		})),
	);
	assert.equal(
		inventory.packages.every(({ status }) => status === "ABSENT"),
		true,
	);
	assert.equal(Object.isFrozen(inventory.packages), true);
});

test("rejects every non-exact npm observation and a reversed or overlong operation clock", async (t) => {
	for (const [name, result] of [
		[
			"present",
			{
				status: "PRESENT",
				operation: "package-version",
				httpStatus: 200,
				code: null,
			},
		],
		[
			"ambiguous",
			{
				status: "AMBIGUOUS",
				operation: "package-version",
				httpStatus: 404,
				code: "E404",
			},
		],
		[
			"wrong status",
			{
				status: "ABSENT",
				operation: "package-version",
				httpStatus: 500,
				code: "E404",
			},
		],
		[
			"wrong code",
			{
				status: "ABSENT",
				operation: "package-version",
				httpStatus: 404,
				code: "HTTP_404",
			},
		],
		[
			"wrong operation",
			{
				status: "ABSENT",
				operation: "package-metadata",
				httpStatus: 404,
				code: "E404",
			},
		],
	]) {
		await t.test(name, async () => {
			await assert.rejects(
				captureNpmInventory({
					stage: "pre-delete-1",
					candidate: DUPLICATE_DRAFT_CANDIDATE,
					npm: Object.freeze({
						async observePackageVersion() {
							return result;
						},
					}),
					now: () => "2026-09-01T12:00:00.000Z",
				}),
				/npm|absence|E404|package-version/iu,
			);
		});
	}

	for (const [name, times] of [
		["reversal", [BASE_TIME + 1, BASE_TIME]],
		["overlong", [BASE_TIME, BASE_TIME + 120_001]],
	]) {
		await t.test(name, async () => {
			let index = 0;
			await assert.rejects(
				captureNpmInventory({
					stage: "pre-delete-1",
					candidate: DUPLICATE_DRAFT_CANDIDATE,
					npm: Object.freeze({
						async observePackageVersion() {
							return absent();
						},
					}),
					now: () =>
						new Date(times[Math.min(index++, times.length - 1)]).toISOString(),
				}),
				/clock|timestamp|duration|monotone/iu,
			);
		});
	}

	await t.test("pairwise package observation reversal", async () => {
		let call = 0;
		await assert.rejects(
			captureNpmInventory({
				stage: "pre-delete-1",
				candidate: DUPLICATE_DRAFT_CANDIDATE,
				npm: Object.freeze({
					async observePackageVersion() {
						return absent();
					},
				}),
				now: () => {
					call += 1;
					const offset = call === 2 ? 10 : call === 3 ? 5 : 10;
					return new Date(BASE_TIME + (call === 1 ? 0 : offset)).toISOString();
				},
			}),
			/monotone|observation|timestamp/iu,
		);
	});
});

test("rejects invalid repository, checkout, workflow, tag, actor, and SHA authority before a writer exists", async (t) => {
	const cases = [
		[
			"dirty checkout",
			(fixture) => (fixture.localState.porcelainStatus = " M package.json"),
		],
		["non-main", (fixture) => (fixture.localState.branch = "release")],
		["detached", (fixture) => (fixture.localState.branch = null)],
		[
			"origin mismatch",
			(fixture) => (fixture.localState.originMainSha = "b".repeat(40)),
		],
		[
			"GitHub mismatch",
			(fixture) => (fixture.githubMainSha.value = "b".repeat(40)),
		],
		["repository", (fixture) => (fixture.repository.name = "cacheplane/other")],
		["repository id", (fixture) => (fixture.repository.id = "1")],
		["actor", (fixture) => (fixture.actor.login = "someone-else")],
		["actor id", (fixture) => (fixture.actor.id = "1")],
		["workflow state", (fixture) => (fixture.workflow.state = "active")],
		[
			"workflow path",
			(fixture) => (fixture.workflow.path = ".github/workflows/ci.yml"),
		],
		["active run", (fixture) => fixture.nonterminalRuns.push({ id: "1" })],
		[
			"moved tag",
			(fixture) => (fixture.annotatedTag.targetSha = "b".repeat(40)),
		],
		[
			"lightweight tag",
			(fixture) => (fixture.annotatedTag.objectType = "commit"),
		],
	];

	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			const fixture = await authorityFixture();
			mutate(fixture);
			await assert.rejects(
				captureConsolidationAuthority(fixture.input),
				/repository|actor|checkout|branch|clean|SHA|workflow|run|tag|authority/iu,
			);
		});
	}
});

test("rejects wrong stage sets, missing or changed drafts, and target disagreement", async (t) => {
	for (const [name, mutate] of [
		[
			"wrong target",
			(fixture) => (fixture.input.targetReleaseId = DUPLICATE_DRAFT_IDS[1]),
		],
		["missing draft", (fixture) => fixture.remainingReleases.splice(1, 1)],
		[
			"extra managed draft",
			(fixture) =>
				fixture.remainingReleases.push({
					...structuredClone(fixture.remainingReleases[1]),
					id: 999999999,
				}),
		],
		[
			"published draft",
			(fixture) =>
				(fixture.remainingReleases[1].published_at = "2026-09-01T12:00:00Z"),
		],
		[
			"changed body",
			(fixture) => (fixture.remainingReleases[1].name = "changed"),
		],
		[
			"target/list disagreement",
			(fixture) => (fixture.directRelease.updated_at = "2026-09-01T11:59:59Z"),
		],
	]) {
		await t.test(name, async () => {
			const fixture = await authorityFixture();
			mutate(fixture);
			await assert.rejects(
				captureConsolidationAuthority(fixture.input),
				/release|draft|target|proposal|parity|managed|identity|digest/iu,
			);
		});
	}
});

test("epoch rejects proposal drift before invoking the journal-intent writer", async () => {
	const fixture = await authorityFixture();
	const captured = await captureConsolidationAuthority(fixture.input);
	const driftedProposal = structuredClone(fixture.proposal);
	driftedProposal.inspectedAt = "2026-09-01T11:59:59.000Z";

	await assert.rejects(
		captured.networkEpoch.consume({
			authority: captured.authority,
			proposal: driftedProposal,
			targetReleaseId: DUPLICATE_DRAFT_IDS[0],
			now: new Date(fixture.nowMs).toISOString(),
			writeIntent: async () => assert.fail("drifted proposal must not write"),
		}),
		/proposal|binding|changed/iu,
	);
	await assert.rejects(
		captured.networkEpoch.consume({
			authority: captured.authority,
			proposal: fixture.proposal,
			targetReleaseId: DUPLICATE_DRAFT_IDS[0],
			now: new Date(fixture.nowMs).toISOString(),
			writeIntent: async () => assert.fail("burned epoch must not write"),
		}),
		/consumed|epoch/iu,
	);
});

test("epoch attempts burn before validation and callback failures", async (t) => {
	const invalidCases = [
		[
			"wrong authority",
			({ authority }) => {
				authority.controller.headSha = "b".repeat(40);
			},
		],
		[
			"wrong target",
			({ consumption }) => {
				consumption.targetReleaseId = DUPLICATE_DRAFT_IDS[1];
			},
		],
		[
			"invalid now",
			({ consumption }) => {
				consumption.now = "2026-09-01T12:00:00Z";
			},
		],
		[
			"stale now",
			({ authority, consumption }) => {
				consumption.now = new Date(
					Date.parse(authority.npmInventory.completedAt) + 120_001,
				).toISOString();
			},
		],
		[
			"future now",
			({ authority, consumption }) => {
				consumption.now = new Date(
					Date.parse(authority.observedAt) - 1,
				).toISOString();
			},
		],
	];
	for (const [name, mutate] of invalidCases) {
		await t.test(name, async () => {
			const fixture = await authorityFixture();
			const captured = await captureConsolidationAuthority(fixture.input);
			const authority = structuredClone(captured.authority);
			let writes = 0;
			const consumption = {
				authority,
				proposal: fixture.proposal,
				targetReleaseId: DUPLICATE_DRAFT_IDS[0],
				now: new Date(fixture.nowMs).toISOString(),
				writeIntent: async () => {
					writes += 1;
				},
			};
			mutate({ authority, consumption });
			await assert.rejects(
				captured.networkEpoch.consume(consumption),
				/authority|binding|canonical|clock|epoch|fresh|future|proposal|sha|stale|target|timestamp/iu,
			);
			assert.equal(writes, 0);
			await assert.rejects(
				captured.networkEpoch.consume({
					...consumption,
					authority: captured.authority,
					targetReleaseId: DUPLICATE_DRAFT_IDS[0],
					now: new Date(fixture.nowMs).toISOString(),
				}),
				/consumed|epoch/iu,
			);
			assert.equal(writes, 0);
		});
	}

	await t.test("callback failure", async () => {
		const fixture = await authorityFixture();
		const captured = await captureConsolidationAuthority(fixture.input);
		const consumption = {
			authority: captured.authority,
			proposal: fixture.proposal,
			targetReleaseId: DUPLICATE_DRAFT_IDS[0],
			now: new Date(fixture.nowMs).toISOString(),
			writeIntent: async () => {
				throw new Error("secret callback failure");
			},
		};
		await assert.rejects(
			captured.networkEpoch.consume(consumption),
			/may already be durable.*do not delete/iu,
		);
		await assert.rejects(
			captured.networkEpoch.consume(consumption),
			/consumed|epoch/iu,
		);
	});
});

test("epoch rejects counter drift while a deferred journal intent is pending", async () => {
	const fixture = await authorityFixture();
	const captured = await captureConsolidationAuthority(fixture.input);
	let signalEntered;
	let finishWrite;
	const entered = new Promise((resolve) => {
		signalEntered = resolve;
	});
	const pendingWrite = new Promise((resolve) => {
		finishWrite = resolve;
	});
	let destructiveContinuation = false;
	const consumption = captured.networkEpoch
		.consume({
			authority: captured.authority,
			proposal: fixture.proposal,
			targetReleaseId: DUPLICATE_DRAFT_IDS[0],
			now: new Date(fixture.nowMs).toISOString(),
			writeIntent: async () => {
				signalEntered();
				return pendingWrite;
			},
		})
		.then(() => {
			destructiveContinuation = true;
		});
	await entered;
	fixture.incrementNetworkRead();
	finishWrite("DELETE_PERMISSION");
	await assert.rejects(
		consumption,
		/may already be durable|do not delete|intent.*durable/iu,
	);
	assert.equal(destructiveContinuation, false);
	await assert.rejects(
		captured.networkEpoch.consume({
			authority: captured.authority,
			proposal: fixture.proposal,
			targetReleaseId: DUPLICATE_DRAFT_IDS[0],
			now: new Date(fixture.nowMs).toISOString(),
			writeIntent: async () => assert.fail("burned epoch must not write"),
		}),
		/consumed|epoch/iu,
	);
});

test("captures pre-delete-2 and final authority with their exact remaining-set rules", async () => {
	const second = await authorityFixture({ stage: "pre-delete-2" });
	const secondCapture = await captureConsolidationAuthority(second.input);
	assert.deepEqual(
		secondCapture.authority.releases.map(({ id }) => id),
		[DUPLICATE_DRAFT_SURVIVOR_ID, DUPLICATE_DRAFT_IDS[1]],
	);
	assert.equal(
		secondCapture.authority.targetRead.evidence.id,
		DUPLICATE_DRAFT_IDS[1],
	);
	assert.equal(
		second.networkOperations.filter((entry) => entry.startsWith("download:"))
			.length,
		90,
	);

	const final = await authorityFixture({ stage: "final" });
	const finalCapture = await captureConsolidationAuthority(final.input);
	assert.deepEqual(
		finalCapture.authority.releases.map(({ id }) => id),
		[DUPLICATE_DRAFT_SURVIVOR_ID],
	);
	assert.equal(finalCapture.authority.targetRead, null);
	assert.equal(
		final.networkOperations.filter((entry) => entry.startsWith("download:"))
			.length,
		45,
	);
	assert.equal(final.networkOperations.at(-1).startsWith("download:"), true);
});

test("writer freshness accepts exactly 120000ms and rejects 120001ms, future evidence, and noncanonical clocks", async () => {
	const fixture = await authorityFixture();
	const { authority } = await captureConsolidationAuthority(fixture.input);
	const completed = Date.parse(authority.npmInventory.completedAt);

	assert.doesNotThrow(() =>
		assertFreshWriterAuthority(
			authority,
			fixture.proposal,
			new Date(completed + 120_000).toISOString(),
		),
	);
	assert.throws(
		() =>
			assertFreshWriterAuthority(
				authority,
				fixture.proposal,
				new Date(completed + 120_001).toISOString(),
			),
		/stale|fresh|120/iu,
	);
	assert.throws(
		() =>
			assertFreshWriterAuthority(
				authority,
				fixture.proposal,
				new Date(Date.parse(authority.observedAt) - 1).toISOString(),
			),
		/future|clock|timestamp/iu,
	);
	assert.throws(
		() =>
			assertFreshWriterAuthority(
				authority,
				fixture.proposal,
				"2026-09-01T12:00:00Z",
			),
		/canonical|timestamp|clock/iu,
	);

	const reorderedPackages = structuredClone(authority);
	reorderedPackages.npmInventory.packages[1].observedAt =
		reorderedPackages.npmInventory.startedAt;
	assert.throws(
		() =>
			assertFreshWriterAuthority(
				reorderedPackages,
				fixture.proposal,
				authority.observedAt,
			),
		/order|monotone|timestamp/iu,
	);

	const reorderedPhases = structuredClone(authority);
	reorderedPhases.workflowAuthority.observedAt =
		reorderedPhases.npmInventory.packages[0].observedAt;
	assert.throws(
		() =>
			assertFreshWriterAuthority(
				reorderedPhases,
				fixture.proposal,
				authority.observedAt,
			),
		/order|monotone|timestamp/iu,
	);
});

test("writer validation owns every adjacent target-read chronology boundary", async (t) => {
	const fixture = await authorityFixture();
	const { authority } = await captureConsolidationAuthority(fixture.input);
	const ordered = structuredClone(authority);
	let timestamp = Date.parse(ordered.npmInventory.completedAt);
	for (const [object, key] of [
		[ordered.targetRead, "releaseGetStartedAt"],
		[ordered.targetRead, "releaseGetCompletedAt"],
		[ordered.targetRead, "assetsListStartedAt"],
		[ordered.targetRead, "assetsListCompletedAt"],
		[ordered, "observedAt"],
	]) {
		timestamp += 1;
		object[key] = new Date(timestamp).toISOString();
	}
	const boundaries = [
		[
			"npm completion to release GET start",
			(authorityValue) => authorityValue.npmInventory.completedAt,
			(authorityValue) => [authorityValue.targetRead, "releaseGetStartedAt"],
		],
		[
			"release GET start to completion",
			(authorityValue) => authorityValue.targetRead.releaseGetStartedAt,
			(authorityValue) => [authorityValue.targetRead, "releaseGetCompletedAt"],
		],
		[
			"release GET completion to asset-list start",
			(authorityValue) => authorityValue.targetRead.releaseGetCompletedAt,
			(authorityValue) => [authorityValue.targetRead, "assetsListStartedAt"],
		],
		[
			"asset-list start to completion",
			(authorityValue) => authorityValue.targetRead.assetsListStartedAt,
			(authorityValue) => [authorityValue.targetRead, "assetsListCompletedAt"],
		],
		[
			"asset-list completion to authority observation",
			(authorityValue) => authorityValue.targetRead.assetsListCompletedAt,
			(authorityValue) => [authorityValue, "observedAt"],
		],
	];
	for (const [name, earlierValue, laterLocation] of boundaries) {
		await t.test(`${name} accepts equality`, () => {
			const equal = structuredClone(ordered);
			const [object, key] = laterLocation(equal);
			object[key] = earlierValue(equal);
			assert.doesNotThrow(() =>
				assertFreshWriterAuthority(
					equal,
					fixture.proposal,
					new Date(timestamp + 1).toISOString(),
				),
			);
		});
		await t.test(`${name} rejects reversal`, () => {
			const reversed = structuredClone(ordered);
			const [object, key] = laterLocation(reversed);
			object[key] = new Date(
				Date.parse(earlierValue(reversed)) - 1,
			).toISOString();
			assert.throws(
				() =>
					assertFreshWriterAuthority(
						reversed,
						fixture.proposal,
						new Date(timestamp + 1).toISOString(),
					),
				/chronology|monotone|target|timestamp/iu,
			);
		});
	}
});

test("descriptor-hostile inputs fail without invoking getters", async () => {
	const fixture = await authorityFixture();
	let invoked = false;
	const hostile = {};
	Object.defineProperty(hostile, "stage", {
		enumerable: true,
		get() {
			invoked = true;
			throw new Error("secret getter payload");
		},
	});

	await assert.rejects(
		captureConsolidationAuthority(hostile),
		/input|descriptor|data/iu,
	);
	assert.equal(invoked, false);
	await assert.rejects(
		captureConsolidationAuthority(new Proxy(fixture.input, {})),
		/proxy|input/iu,
	);
	assert.equal(invoked, false);
});

test("rejects symbol, hidden, sparse, nonplain, and mutable dependency inputs", async (t) => {
	const malformedRoots = [];
	const withSymbol = { stage: "pre-delete-1" };
	withSymbol[Symbol("hidden")] = true;
	malformedRoots.push(["symbol", withSymbol]);
	const withHidden = { stage: "pre-delete-1" };
	Object.defineProperty(withHidden, "hidden", { value: true });
	malformedRoots.push(["hidden", withHidden]);
	malformedRoots.push(["nonplain", Object.create({ stage: "pre-delete-1" })]);
	for (const [name, value] of malformedRoots) {
		await t.test(name, async () => {
			await assert.rejects(
				captureConsolidationAuthority(value),
				/input|field|plain|symbol|descriptor/iu,
			);
		});
	}

	await t.test("sparse", async () => {
		const fixture = await authorityFixture();
		const proposal = structuredClone(fixture.proposal);
		proposal.roles.duplicates = Array(2);
		fixture.input.proposal = proposal;
		await assert.rejects(
			captureConsolidationAuthority(fixture.input),
			/dense|array|proposal/iu,
		);
	});
	await t.test("mutable dependency", async () => {
		const fixture = await authorityFixture();
		fixture.input.local = {
			async readState() {
				return fixture.localState;
			},
		};
		await assert.rejects(
			captureConsolidationAuthority(fixture.input),
			/immutable|reader/iu,
		);
	});
});

test("rejects future service observations and authority that ages out during broad reads", async () => {
	const future = await authorityFixture();
	future.remainingReleases[0].updated_at = "2026-09-02T00:00:00Z";
	await assert.rejects(
		captureConsolidationAuthority(future.input),
		/future|observation|timestamp|monotone/iu,
	);

	const stale = await authorityFixture();
	let calls = 0;
	stale.input.now = () => {
		calls += 1;
		return new Date(BASE_TIME + (calls > 24 ? 120_001 : 0)).toISOString();
	};
	await assert.rejects(
		captureConsolidationAuthority(stale.input),
		/stale|fresh|120000/iu,
	);
});

test("redacts dependency failures instead of exposing untrusted controls", async () => {
	const fixture = await authorityFixture();
	fixture.input.local = Object.freeze({
		async readState() {
			throw new Error("github_test_token_123\u0000payload");
		},
	});
	await assert.rejects(
		captureConsolidationAuthority(fixture.input),
		(error) => {
			assert.equal(error.message.includes("github_test_token_123"), false);
			assert.equal(error.message.includes("payload"), false);
			return true;
		},
	);
});

async function authorityFixture({ stage = "pre-delete-1" } = {}) {
	const evidenceFixture = createDuplicateDraftConsolidationFixture();
	const inspected = await inspectEquivalentDrafts({
		candidate: evidenceFixture.candidate,
		survivorId: evidenceFixture.survivorId,
		duplicateIds: evidenceFixture.duplicateIds,
		releases: evidenceFixture.releases,
		github: evidenceFixture.github,
		attestations: evidenceFixture.attestations,
	});
	evidenceFixture.clearOperations();
	let nowMs = BASE_TIME;
	let readCount = 0;
	const networkOperations = [];
	const expectedIds =
		stage === "pre-delete-1"
			? [DUPLICATE_DRAFT_SURVIVOR_ID, ...DUPLICATE_DRAFT_IDS]
			: stage === "pre-delete-2"
				? [DUPLICATE_DRAFT_SURVIVOR_ID, DUPLICATE_DRAFT_IDS[1]]
				: [DUPLICATE_DRAFT_SURVIVOR_ID];
	const remainingReleases = evidenceFixture.releases
		.filter(({ id }) => expectedIds.includes(String(id)))
		.map((release) => structuredClone(release));
	const directRelease = structuredClone(
		remainingReleases.find(
			({ id }) =>
				String(id) ===
				(stage === "pre-delete-2"
					? DUPLICATE_DRAFT_IDS[1]
					: DUPLICATE_DRAFT_IDS[0]),
		),
	);
	const repository = {
		name: "cacheplane/dawnai",
		id: REPOSITORY_ID,
		defaultBranch: "main",
	};
	const actor = { ...ACTOR };
	const githubMainSha = { value: DUPLICATE_DRAFT_CANDIDATE.commitSha };
	const workflow = {
		workflowId: WORKFLOW_ID,
		path: ".github/workflows/release.yml",
		state: "disabled_manually",
	};
	const nonterminalRuns = [];
	const annotatedTag = {
		name: "v0.8.22",
		objectSha: TAG_OBJECT_SHA,
		targetSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
		objectType: "tag",
		observedAt: new Date(BASE_TIME).toISOString(),
	};
	const localState = {
		headSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
		branch: "main",
		porcelainStatus: "",
		originMainSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
	};
	const log = (operation) => {
		readCount += 1;
		networkOperations.push(operation);
	};
	const github = Object.freeze({
		async getRepository() {
			log("repository");
			return structuredClone(repository);
		},
		async getAuthenticatedUser() {
			log("user");
			return structuredClone(actor);
		},
		async getDefaultBranchSha() {
			log("default-branch");
			return githubMainSha.value;
		},
		async getWorkflowState() {
			log("workflow");
			return structuredClone(workflow);
		},
		async listNonterminalWorkflowRuns() {
			log("workflow-runs");
			return structuredClone(nonterminalRuns);
		},
		async getAnnotatedTag() {
			log("tag");
			return structuredClone(annotatedTag);
		},
		async listReleases() {
			log("releases");
			return present("releases", structuredClone(remainingReleases));
		},
		async downloadReleaseAsset(input) {
			log(`download:${input.releaseId}:${input.assetId}`);
			return evidenceFixture.github.downloadReleaseAsset(input);
		},
		async getRelease({ releaseId }) {
			log(`get-release:${releaseId}`);
			if (
				directRelease === undefined ||
				String(directRelease.id) !== String(releaseId)
			) {
				throw new Error("fixture direct release mismatch");
			}
			return present("release", structuredClone(directRelease));
		},
		async listReleaseAssets({ releaseId }) {
			log(`list-assets:${releaseId}`);
			if (
				directRelease === undefined ||
				String(directRelease.id) !== String(releaseId)
			) {
				throw new Error("fixture direct asset mismatch");
			}
			return present("release-assets", structuredClone(directRelease.assets));
		},
	});
	const npm = Object.freeze({
		async observePackageVersion({ name }) {
			log(`npm:${name}`);
			nowMs += 1;
			return absent();
		},
	});
	const proposal = deepFreeze(
		createConsolidationEnvelope("proposed", {
			schemaVersion: 1,
			repository: {
				name: "cacheplane/dawnai",
				id: REPOSITORY_ID,
				defaultBranch: "main",
				actor: { ...ACTOR },
			},
			controller: {
				headSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
				originMainSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
				githubMainSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
			},
			candidate: DUPLICATE_DRAFT_CANDIDATE,
			roles: {
				survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
				duplicates: [...DUPLICATE_DRAFT_IDS],
			},
			confirmation: {
				version: "0.8.22",
				commitSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
				survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
				duplicates: [...DUPLICATE_DRAFT_IDS],
				template: "Consolidate <64-lowercase-hex-digest>",
			},
			annotatedTag: { ...annotatedTag },
			workflowAuthority: {
				...workflow,
				query: {
					statuses: [
						"in_progress",
						"pending",
						"queued",
						"requested",
						"waiting",
					],
					perPage: 100,
					maximumPages: 100,
				},
				nonterminalRuns: [],
				observedAt: new Date(BASE_TIME).toISOString(),
			},
			npmInventories: [
				npmInventory("inspect-initial"),
				npmInventory("inspect-ready"),
			],
			releases: inspected.releases,
			payloadProof: inspected.payloadProof,
			inspectedAt: new Date(BASE_TIME).toISOString(),
		}).record,
	);
	const input = {
		stage,
		proposal,
		targetReleaseId:
			stage === "final"
				? null
				: stage === "pre-delete-1"
					? DUPLICATE_DRAFT_IDS[0]
					: DUPLICATE_DRAFT_IDS[1],
		local: Object.freeze({
			async readState() {
				return structuredClone(localState);
			},
		}),
		github,
		npm,
		attestations: evidenceFixture.attestations,
		networkReadCount: () => readCount,
		now: () => new Date(nowMs).toISOString(),
	};
	return {
		input,
		proposal,
		localState,
		repository,
		actor,
		githubMainSha,
		workflow,
		nonterminalRuns,
		annotatedTag,
		remainingReleases,
		get directRelease() {
			return directRelease;
		},
		get networkOperations() {
			return [...networkOperations];
		},
		get nowMs() {
			return nowMs;
		},
		incrementNetworkRead() {
			readCount += 1;
		},
	};
}

function npmInventory(stage) {
	return {
		stage,
		startedAt: new Date(BASE_TIME).toISOString(),
		completedAt: new Date(BASE_TIME).toISOString(),
		packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => ({
			name,
			version: "0.8.22",
			status: "ABSENT",
			httpStatus: 404,
			code: "E404",
			observedAt: new Date(BASE_TIME).toISOString(),
		})),
	};
}

function absent() {
	return {
		status: "ABSENT",
		operation: "package-version",
		httpStatus: 404,
		code: "E404",
	};
}

function present(operation, value) {
	return { status: "PRESENT", operation, httpStatus: 200, code: null, value };
}

function deepFreeze(value) {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}
