import assert from "node:assert/strict";
import test from "node:test";

import {
	assertEvidenceEqualsProposal,
	captureDirectTargetRead,
	inspectEquivalentDrafts,
	parseReleaseEvidence,
	semanticAssetProjection,
	semanticReleaseProjection,
} from "../duplicate-draft-consolidation-evidence.mjs";
import { RELEASE_PAYLOAD_LIMITS } from "../limits.mjs";
import {
	createDuplicateDraftConsolidationFixture,
	DUPLICATE_DRAFT_CANDIDATE,
	DUPLICATE_DRAFT_IDS,
	DUPLICATE_DRAFT_SURVIVOR_ID,
} from "./support/duplicate-draft-consolidation-fixture.mjs";

const INPUT = (fixture) => ({
	candidate: fixture.candidate,
	survivorId: fixture.survivorId,
	duplicateIds: fixture.duplicateIds,
	releases: fixture.releases,
	github: fixture.github,
	attestations: fixture.attestations,
});

test("proves three ordered mutable drafts have the exact production 45-asset escrow", async () => {
	const fixture = createDuplicateDraftConsolidationFixture();
	const result = await inspectEquivalentDrafts(INPUT(fixture));

	assert.notDeepEqual(
		fixture.releases[0].assets.map(({ name }) => name),
		fixture.expectedBaseAssetSet.map(({ name }) => name),
		"the fixture must preserve realistic GitHub list order rather than canonical escrow order",
	);
	assert.deepEqual(
		result.releases.map(({ role, id }) => ({ role, id })),
		[
			{ role: "survivor", id: DUPLICATE_DRAFT_SURVIVOR_ID },
			{ role: "duplicate", id: DUPLICATE_DRAFT_IDS[0] },
			{ role: "duplicate", id: DUPLICATE_DRAFT_IDS[1] },
		],
	);
	assert.deepEqual(
		result.payloadProof.baseAssetSet,
		fixture.expectedBaseAssetSet,
	);
	assert.equal(result.payloadProof.baseAssetSet.length, 45);
	assert.equal(result.payloadProof.attestationVerification.status, "VERIFIED");
	assert.equal(result.payloadProof.attestationVerification.subjects.length, 22);
	assert.equal(result.releases[0].semantic.targetCommitish, "main");
	assert.equal(result.releases[0].createdAt, "2026-08-31T00:00:00.000Z");
	assert.equal(result.releases[0].assets[0].createdAt.endsWith(".000Z"), true);
	assert.equal(fixture.downloadCount, 135);
	assert.equal(Object.isFrozen(result), true);
	assert.equal(Object.isFrozen(result.releases[0].assets), true);
	assert.deepEqual(
		result.releases.map(semanticReleaseProjection),
		Array.from({ length: 3 }, () =>
			semanticReleaseProjection(result.releases[0]),
		),
	);
	assert.deepEqual(
		result.releases.map((release) =>
			release.assets.map(semanticAssetProjection),
		),
		Array.from({ length: 3 }, () =>
			result.releases[0].assets.map(semanticAssetProjection),
		),
	);
});

test("normalizes exact GitHub timestamps and rejects invalid raw calendar or precision forms", async (t) => {
	const cases = [
		["Release creation", (release, value) => (release.created_at = value)],
		["Release update", (release, value) => (release.updated_at = value)],
		[
			"asset creation",
			(release, value) => (release.assets[0].created_at = value),
		],
		[
			"asset update",
			(release, value) => (release.assets[0].updated_at = value),
		],
	];
	for (const [name, mutate] of cases) {
		await t.test(`${name} second precision`, async () => {
			const fixture = createDuplicateDraftConsolidationFixture();
			mutate(fixture.releases[0], "2026-08-31T19:15:59Z");
			const result = await inspectEquivalentDrafts(INPUT(fixture));
			const evidence = result.releases[0];
			const normalized = name.startsWith("Release")
				? name.endsWith("creation")
					? evidence.createdAt
					: evidence.updatedAt
				: name.endsWith("creation")
					? evidence.assets.find(
							({ name }) => name === fixture.releases[0].assets[0].name,
						).createdAt
					: evidence.assets.find(
							({ name }) => name === fixture.releases[0].assets[0].name,
						).updatedAt;
			assert.equal(normalized, "2026-08-31T19:15:59.000Z");
		});
		for (const invalid of [
			"2026-02-30T19:15:59Z",
			"2026-08-31T19:15:59.00Z",
			"2026-08-31T19:15:59+00:00",
			"2026-08-31T19:15:60Z",
		]) {
			await t.test(`${name} rejects ${invalid}`, async () => {
				const fixture = createDuplicateDraftConsolidationFixture();
				mutate(fixture.releases[0], invalid);
				await assert.rejects(
					inspectEquivalentDrafts(INPUT(fixture)),
					/timestamp|calendar|GitHub|canonical/iu,
				);
			});
		}
	}
});

test("enforces namespace-specific declared-size caps before any asset download", async (t) => {
	const categories = [
		[
			"release record",
			"release-record.json",
			RELEASE_PAYLOAD_LIMITS.releaseRecordBytes,
		],
		["manifest", "manifest.json", RELEASE_PAYLOAD_LIMITS.manifestBytes],
		[
			"bundle",
			(name) => name.endsWith(".intoto.jsonl"),
			RELEASE_PAYLOAD_LIMITS.attestationBundleBytes,
		],
		[
			"package",
			(name) => name.endsWith(".tgz"),
			RELEASE_PAYLOAD_LIMITS.tarballBytes,
		],
	];
	for (const [label, selector, maximum] of categories) {
		await t.test(`${label} one over`, async () => {
			const fixture = createDuplicateDraftConsolidationFixture();
			const asset = fixture.releases[0].assets.find(({ name }) =>
				typeof selector === "string" ? name === selector : selector(name),
			);
			asset.size = maximum + 1;
			await assert.rejects(
				inspectEquivalentDrafts(INPUT(fixture)),
				/bundle|manifest|package|payload|record|size|tarball/iu,
			);
			assert.equal(fixture.downloadCount, 0);
		});
	}

	const acceptedBoundaries = [
		[
			"release record",
			"release-record.json",
			RELEASE_PAYLOAD_LIMITS.releaseRecordBytes,
		],
		["manifest", "manifest.json", RELEASE_PAYLOAD_LIMITS.manifestBytes],
		[
			"bundle",
			(name) => name.endsWith(".intoto.jsonl"),
			RELEASE_PAYLOAD_LIMITS.attestationBundleBytes,
		],
		[
			"package prepared",
			(name) => name.endsWith(".tgz"),
			RELEASE_PAYLOAD_LIMITS.preparedTarballsBytes,
		],
	];
	for (const [label, selector, maximum] of acceptedBoundaries) {
		await t.test(
			`${label} applicable boundary reaches its download`,
			async () => {
				const fixture = createDuplicateDraftConsolidationFixture();
				const asset = fixture.releases[0].assets.find(({ name }) =>
					typeof selector === "string" ? name === selector : selector(name),
				);
				if (label === "package prepared") {
					for (const other of fixture.releases[0].assets.filter(
						({ name }) => name.endsWith(".tgz") && name !== asset.name,
					)) {
						other.size = 0;
					}
				}
				asset.size = maximum;
				await assert.rejects(
					inspectEquivalentDrafts(INPUT(fixture)),
					/bytes conflict|declared size/iu,
				);
				assert.equal(
					fixture.operations.includes(
						`download:${fixture.survivorId}:${asset.id}`,
					),
					true,
				);
			},
		);
	}
});

test("rejects prepared-package and bundle aggregate overflow before the offending download", async (t) => {
	await t.test("prepared packages", async () => {
		const fixture = createDuplicateDraftConsolidationFixture();
		const asset = fixture.releases[0].assets.find(({ name }) =>
			name.endsWith(".tgz"),
		);
		asset.size = RELEASE_PAYLOAD_LIMITS.preparedTarballsBytes + 1;
		await assert.rejects(
			inspectEquivalentDrafts(INPUT(fixture)),
			/prepared|package|tarball|payload/iu,
		);
		assert.equal(fixture.downloadCount, 0);
	});
	await t.test("attestation bundles", async () => {
		const fixture = createDuplicateDraftConsolidationFixture();
		for (const asset of fixture.releases[0].assets
			.filter(({ name }) => name.endsWith(".intoto.jsonl"))
			.slice(0, 16)) {
			asset.size = RELEASE_PAYLOAD_LIMITS.attestationBundleBytes;
		}
		await assert.rejects(
			inspectEquivalentDrafts(INPUT(fixture)),
			/attestation|bundle|payload/iu,
		);
		assert.equal(fixture.downloadCount, 0);
	});
});

test("excludes only recorded Release and asset service volatility from equality", async (t) => {
	const cases = [
		["Release node id", (release) => (release.node_id = "RE_changed")],
		["opaque tag", (release) => (release.tag_name = "untagged-changed")],
		[
			"Release creation",
			(release) => (release.created_at = "2026-08-30T00:00:00.000Z"),
		],
		[
			"Release update",
			(release) => (release.updated_at = "2026-08-30T00:01:00.000Z"),
		],
		[
			"derived Release URL",
			(release) => (release.html_url = "https://example.invalid/changed"),
		],
		["asset id", (release) => (release.assets[0].id = 777_777_777)],
		["asset node id", (release) => (release.assets[0].node_id = "RA_changed")],
		[
			"asset creation",
			(release) => (release.assets[0].created_at = "2026-08-30T00:00:00.000Z"),
		],
		[
			"asset update",
			(release) => (release.assets[0].updated_at = "2026-08-30T00:01:00.000Z"),
		],
		["download count", (release) => (release.assets[0].download_count = 999)],
		[
			"derived asset URL",
			(release) =>
				(release.assets[0].browser_download_url =
					"https://example.invalid/asset"),
		],
	];
	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			const fixture = createDuplicateDraftConsolidationFixture();
			mutate(fixture.releases[1]);
			const result = await inspectEquivalentDrafts(INPUT(fixture));
			assert.equal(result.releases.length, 3);
		});
	}
});

test("every included Release semantic field blocks parity drift", async (t) => {
	const cases = [
		["name", (release) => (release.name = "Different release")],
		[
			"target commitish",
			(release) => (release.target_commitish = "f".repeat(40)),
		],
		["draft", (release) => (release.draft = false)],
		["immutable", (release) => (release.immutable = true)],
		["prerelease", (release) => (release.prerelease = true)],
		[
			"published at",
			(release) => (release.published_at = "2026-09-01T00:00:00.000Z"),
		],
		["canonical body", (release) => (release.body = `${release.body} `)],
		["author login", (release) => (release.author.login = "somebody-else")],
		["author id", (release) => (release.author.id = 2048)],
		[
			"author node id",
			(release) => (release.author.node_id = "MDQ6VXNlcjIwNDg="),
		],
	];
	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			const fixture = createDuplicateDraftConsolidationFixture();
			mutate(fixture.releases[1]);
			await assert.rejects(
				inspectEquivalentDrafts(INPUT(fixture)),
				/candidate|canonical|equal|mutable|parity|published|author/iu,
			);
		});
	}
});

test("every included asset semantic field blocks parity drift", async (t) => {
	const cases = [
		["name", (asset) => (asset.name = "unknown.bin")],
		["label", (asset) => (asset.label = "changed")],
		["state", (asset) => (asset.state = "new")],
		[
			"content type",
			(asset) => (asset.content_type = "application/octet-stream"),
		],
		["size", (asset) => (asset.size += 1)],
		["digest", (asset) => (asset.digest = `sha256:${"f".repeat(64)}`)],
		["uploader login", (asset) => (asset.uploader.login = "somebody-else")],
		["uploader id", (asset) => (asset.uploader.id = 2048)],
		[
			"uploader node id",
			(asset) => (asset.uploader.node_id = "uploader-changed"),
		],
	];
	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			const fixture = createDuplicateDraftConsolidationFixture();
			mutate(fixture.releases[1].assets[0]);
			await assert.rejects(
				inspectEquivalentDrafts(INPUT(fixture)),
				/asset|digest|download|equal|parity|uploaded|unknown/iu,
			);
		});
	}
});

test("rejects noncanonical core evidence and incorrect downloaded bytes", async (t) => {
	const cases = [
		[
			"malformed marker",
			(fixture) => (fixture.releases[0].body = "not a release marker"),
		],
		["noncanonical marker", (fixture) => (fixture.releases[0].body += "\n")],
		[
			"release record bytes",
			(fixture) =>
				fixture.replaceAssetBytes(
					fixture.survivorId,
					"release-record.json",
					Buffer.from("{}\n"),
					{ updateMetadata: true },
				),
		],
		[
			"manifest bytes",
			(fixture) =>
				fixture.replaceAssetBytes(
					fixture.survivorId,
					"manifest.json",
					Buffer.from("{}\n"),
					{ updateMetadata: true },
				),
		],
		[
			"manifest package order drift",
			(fixture) =>
				mutateManifest(fixture, (manifest) => manifest.packageOrder.reverse()),
		],
		[
			"manifest package name drift",
			(fixture) =>
				mutateManifest(
					fixture,
					(manifest) => (manifest.packages[0].name = "@dawn-ai/not-real"),
				),
		],
		[
			"manifest package hash drift",
			(fixture) =>
				mutateManifest(
					fixture,
					(manifest) => (manifest.packages[0].sha256 = "f".repeat(64)),
				),
		],
		[
			"download mismatch",
			(fixture) =>
				fixture.replaceAssetBytes(
					fixture.survivorId,
					"manifest.json",
					Buffer.from("changed"),
				),
		],
		[
			"bundle set mismatch",
			(fixture) =>
				fixture.replaceAssetBytes(
					fixture.survivorId,
					fixture.releases[0].assets.at(-1).name,
					Buffer.from("different bundle"),
					{ updateMetadata: true },
				),
		],
	];
	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			const fixture = createDuplicateDraftConsolidationFixture();
			mutate(fixture);
			await assert.rejects(
				inspectEquivalentDrafts(INPUT(fixture)),
				/asset|attestation|bundle|canonical|digest|JSON|manifest|marker|package|record/iu,
			);
		});
	}
});

test("rejects a canonical shared marker whose release-record digest is wrong", async () => {
	const fixture = createDuplicateDraftConsolidationFixture();
	fixture.replaceMarker((marker) => {
		marker.releaseRecordSha256 = "f".repeat(64);
	});
	await assert.rejects(
		inspectEquivalentDrafts(INPUT(fixture)),
		/marker|record|digest/iu,
	);
});

test("rejects malformed or non-exact Release asset inventories before destructive evidence exists", async (t) => {
	const cases = [
		["missing asset", (fixture) => fixture.releases[0].assets.pop()],
		[
			"extra asset",
			(fixture) =>
				fixture.releases[0].assets.push({
					...fixture.releases[0].assets[0],
					id: 888_888,
					name: "extra.bin",
				}),
		],
		[
			"duplicate asset name",
			(fixture) =>
				(fixture.releases[0].assets[1].name =
					fixture.releases[0].assets[0].name),
		],
		[
			"duplicate asset id",
			(fixture) =>
				(fixture.releases[0].assets[1].id = fixture.releases[0].assets[0].id),
		],
		[
			"non-uploaded asset",
			(fixture) => (fixture.releases[0].assets[0].state = "new"),
		],
		[
			"missing GitHub digest",
			(fixture) => (fixture.releases[0].assets[0].digest = null),
		],
		[
			"malformed GitHub digest",
			(fixture) =>
				(fixture.releases[0].assets[0].digest = `sha256:${"A".repeat(64)}`),
		],
		[
			"per-Release payload over 64 MiB",
			(fixture) => {
				fixture.releases[0].assets[0].size = 32 * 1024 * 1024;
				fixture.releases[0].assets[1].size = 32 * 1024 * 1024;
				fixture.releases[0].assets[2].size = 1;
			},
		],
	];
	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			const fixture = createDuplicateDraftConsolidationFixture();
			mutate(fixture);
			await assert.rejects(
				inspectEquivalentDrafts(INPUT(fixture)),
				/45|asset|digest|duplicate|escrow|limit|payload|uploaded/iu,
			);
		});
	}
});

test("rejects a fourth matching draft, a published candidate Release, wrong roles, or wrong author", async (t) => {
	await t.test("fourth matching draft", async () => {
		const fixture = createDuplicateDraftConsolidationFixture();
		fixture.releases.push({
			...structuredClone(fixture.releases[0]),
			id: 444_444_444,
			node_id: "RE_fourth",
			tag_name: "untagged-fourth",
		});
		await assert.rejects(
			inspectEquivalentDrafts(INPUT(fixture)),
			/exactly three|fourth|managed/iu,
		);
		assert.equal(fixture.downloadCount, 0);
	});
	await t.test("published candidate", async () => {
		const fixture = createDuplicateDraftConsolidationFixture();
		fixture.releases.push({
			...structuredClone(fixture.releases[0]),
			id: 444_444_444,
			tag_name: DUPLICATE_DRAFT_CANDIDATE.tag,
			draft: false,
			immutable: true,
			published_at: "2026-09-01T00:00:00.000Z",
		});
		await assert.rejects(
			inspectEquivalentDrafts(INPUT(fixture)),
			/published/iu,
		);
	});
	await t.test("reordered roles", async () => {
		const fixture = createDuplicateDraftConsolidationFixture();
		fixture.duplicateIds.reverse();
		await assert.rejects(
			inspectEquivalentDrafts(INPUT(fixture)),
			/approved|order|role/iu,
		);
	});
	await t.test("wrong author", async () => {
		const fixture = createDuplicateDraftConsolidationFixture();
		for (const release of fixture.releases)
			release.author.login = "wrong-owner";
		await assert.rejects(inspectEquivalentDrafts(INPUT(fixture)), /author/iu);
	});
	await t.test("wrong author stable id", async () => {
		const fixture = createDuplicateDraftConsolidationFixture();
		for (const release of fixture.releases) release.author.id = 2048;
		await assert.rejects(inspectEquivalentDrafts(INPUT(fixture)), /author/iu);
	});
	await t.test("wrong author node id", async () => {
		const fixture = createDuplicateDraftConsolidationFixture();
		for (const release of fixture.releases)
			release.author.node_id = "MDQ6VXNlcjIwNDg=";
		await assert.rejects(inspectEquivalentDrafts(INPUT(fixture)), /author/iu);
	});
	await t.test("failed attestation verification", async () => {
		const fixture = createDuplicateDraftConsolidationFixture();
		fixture.failVerification();
		await assert.rejects(
			inspectEquivalentDrafts(INPUT(fixture)),
			/attestation|verification/iu,
		);
	});
});

test("rejects an oversized download envelope before base64 decoding", async () => {
	const fixture = createDuplicateDraftConsolidationFixture();
	const github = {
		...fixture.github,
		async downloadReleaseAsset() {
			return {
				status: "PRESENT",
				operation: "release-asset-download",
				httpStatus: 200,
				code: null,
				contentBase64: "A".repeat(1024 * 1024),
			};
		},
	};
	await assert.rejects(
		inspectEquivalentDrafts({ ...INPUT(fixture), github }),
		/base64|declared|download|size/iu,
	);
});

test("enforces aggregate accounting before a 136th download or a 192 MiB crossing", async (t) => {
	await t.test("136th download", async () => {
		const fixture = createDuplicateDraftConsolidationFixture();
		await assert.rejects(
			inspectEquivalentDrafts({
				...INPUT(fixture),
				accounting: { downloadedAssets: 1, downloadedBytes: 0 },
			}),
			/135|download/iu,
		);
		assert.equal(fixture.downloadCount, 0);
	});
	await t.test("aggregate byte crossing", async () => {
		const fixture = createDuplicateDraftConsolidationFixture();
		await assert.rejects(
			inspectEquivalentDrafts({
				...INPUT(fixture),
				accounting: {
					downloadedAssets: 0,
					downloadedBytes: 192 * 1024 * 1024,
				},
			}),
			/192|aggregate|payload/iu,
		);
		assert.equal(fixture.downloadCount, 0);
	});
});

test("captures a bounded monotone direct Release-by-ID and complete asset read", async () => {
	const fixture = createDuplicateDraftConsolidationFixture();
	const inspected = await inspectEquivalentDrafts(INPUT(fixture));
	fixture.clearOperations();
	const timestamps = [
		"2026-09-01T12:00:00.000Z",
		"2026-09-01T12:00:01.000Z",
		"2026-09-01T12:00:02.000Z",
		"2026-09-01T12:00:03.000Z",
	];
	const direct = await captureDirectTargetRead({
		candidate: fixture.candidate,
		releaseId: DUPLICATE_DRAFT_IDS[0],
		role: "duplicate",
		expectedEvidence: inspected.releases[1],
		github: fixture.github,
		now: () => timestamps.shift(),
	});

	assert.deepEqual(Object.fromEntries(Object.entries(direct).slice(0, 4)), {
		releaseGetStartedAt: "2026-09-01T12:00:00.000Z",
		releaseGetCompletedAt: "2026-09-01T12:00:01.000Z",
		assetsListStartedAt: "2026-09-01T12:00:02.000Z",
		assetsListCompletedAt: "2026-09-01T12:00:03.000Z",
	});
	assert.equal(direct.evidence.id, DUPLICATE_DRAFT_IDS[0]);
	assert.match(direct.evidenceSha256, /^[0-9a-f]{64}$/u);
	assert.equal(Object.isFrozen(direct), true);
	assert.deepEqual(fixture.operations, [
		`get:${DUPLICATE_DRAFT_IDS[0]}`,
		`list-assets:${DUPLICATE_DRAFT_IDS[0]}`,
	]);
});

test("direct target reads allow approved service volatility and return its latest metadata", async (t) => {
	const cases = [
		["Release node id", (release) => (release.node_id = "RE_latest")],
		["opaque tag", (release) => (release.tag_name = "untagged-latest")],
		[
			"Release creation",
			(release) => (release.created_at = "2026-08-29T00:00:00.000Z"),
		],
		[
			"Release update",
			(release) => (release.updated_at = "2026-09-01T00:00:00.000Z"),
		],
		["asset id", (release) => (release.assets[0].id = 777_777_777)],
		["asset node id", (release) => (release.assets[0].node_id = "RA_latest")],
		[
			"asset creation",
			(release) => (release.assets[0].created_at = "2026-08-29T00:00:00.000Z"),
		],
		[
			"asset update",
			(release) => (release.assets[0].updated_at = "2026-09-01T00:00:00.000Z"),
		],
		["download count", (release) => (release.assets[0].download_count = 999)],
	];
	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			const fixture = createDuplicateDraftConsolidationFixture();
			const inspected = await inspectEquivalentDrafts(INPUT(fixture));
			mutate(fixture.releases[1]);
			fixture.clearOperations();
			const direct = await captureDirectTargetRead({
				candidate: fixture.candidate,
				releaseId: DUPLICATE_DRAFT_IDS[0],
				role: "duplicate",
				expectedEvidence: inspected.releases[1],
				github: fixture.github,
			});
			assert.deepEqual(fixture.operations, [
				`get:${DUPLICATE_DRAFT_IDS[0]}`,
				`list-assets:${DUPLICATE_DRAFT_IDS[0]}`,
			]);
			assert.deepEqual(
				semanticReleaseProjection(direct.evidence),
				semanticReleaseProjection(inspected.releases[1]),
			);
		});
	}
});

test("direct target reads reject nonmonotone clocks and every included parity drift", async (t) => {
	const setup = async () => {
		const fixture = createDuplicateDraftConsolidationFixture();
		const inspected = await inspectEquivalentDrafts(INPUT(fixture));
		return { fixture, inspected };
	};
	await t.test("nonmonotone", async () => {
		const { fixture, inspected } = await setup();
		const timestamps = ["2026-09-01T12:00:01.000Z", "2026-09-01T12:00:00.000Z"];
		await assert.rejects(
			captureDirectTargetRead({
				candidate: fixture.candidate,
				releaseId: DUPLICATE_DRAFT_IDS[0],
				role: "duplicate",
				expectedEvidence: inspected.releases[1],
				github: fixture.github,
				now: () => timestamps.shift() ?? "2026-09-01T12:00:02.000Z",
			}),
			/monotone|timestamp/iu,
		);
	});
	const cases = [
		["name", (release) => (release.name = "changed")],
		["target", (release) => (release.target_commitish = "f".repeat(40))],
		["draft", (release) => (release.draft = false)],
		["immutable", (release) => (release.immutable = true)],
		["prerelease", (release) => (release.prerelease = true)],
		[
			"published",
			(release) => (release.published_at = "2026-09-01T00:00:00.000Z"),
		],
		["body", (release) => (release.body += " ")],
		["author", (release) => (release.author.id = 2048)],
		["asset name", (release) => (release.assets[0].name = "wrong.bin")],
		["asset label", (release) => (release.assets[0].label = "changed")],
		["asset state", (release) => (release.assets[0].state = "new")],
		[
			"asset content type",
			(release) => (release.assets[0].content_type = "text/plain"),
		],
		["asset size", (release) => (release.assets[0].size += 1)],
		[
			"asset digest",
			(release) => (release.assets[0].digest = `sha256:${"f".repeat(64)}`),
		],
		["asset uploader", (release) => (release.assets[0].uploader.id = 2048)],
	];
	for (const [name, mutate] of cases) {
		await t.test(name, async () => {
			const { fixture, inspected } = await setup();
			mutate(fixture.releases[1]);
			fixture.clearOperations();
			await assert.rejects(
				captureDirectTargetRead({
					candidate: fixture.candidate,
					releaseId: DUPLICATE_DRAFT_IDS[0],
					role: "duplicate",
					expectedEvidence: inspected.releases[1],
					github: fixture.github,
				}),
				/asset|author|body|candidate|digest|evidence|equal|expected|marker|mutable|parity|proposal|uploaded/iu,
			);
			assert.deepEqual(fixture.operations, [
				`get:${DUPLICATE_DRAFT_IDS[0]}`,
				`list-assets:${DUPLICATE_DRAFT_IDS[0]}`,
			]);
		});
	}
});

test("public evidence parsers reject hostile shapes without invoking accessors and return owned frozen data", async () => {
	const fixture = createDuplicateDraftConsolidationFixture();
	const result = await inspectEquivalentDrafts(INPUT(fixture));
	const source = structuredClone(result.releases[0]);
	const parsed = parseReleaseEvidence(source);
	source.semantic.name = "mutated later";
	assert.notEqual(parsed.semantic.name, source.semantic.name);
	assert.equal(Object.isFrozen(parsed), true);
	assert.equal(Object.isFrozen(parsed.semantic), true);
	assert.deepEqual(
		assertEvidenceEqualsProposal(parsed, result.releases[0]),
		parsed,
	);
	const volatile = structuredClone(result.releases[0]);
	volatile.nodeId = "RE_latest";
	volatile.tagName = "untagged-latest";
	volatile.createdAt = "2026-08-29T00:00:00.000Z";
	volatile.updatedAt = "2026-09-01T00:00:00.000Z";
	volatile.assets[0].id = "777777777";
	volatile.assets[0].nodeId = "RA_latest";
	volatile.assets[0].downloadCount = 999;
	assert.deepEqual(
		assertEvidenceEqualsProposal(volatile, parsed),
		parseReleaseEvidence(volatile),
	);
	const oversized = structuredClone(result.releases[0]);
	oversized.assets[0].size = 32 * 1024 * 1024;
	oversized.assets[1].size = 32 * 1024 * 1024;
	oversized.assets[2].size = 1;
	assert.throws(
		() => parseReleaseEvidence(oversized),
		/escrow|payload|limit/iu,
	);

	let invoked = false;
	const accessor = Object.defineProperty({}, "role", {
		enumerable: true,
		get() {
			invoked = true;
			throw new Error("must not run");
		},
	});
	for (const value of [
		accessor,
		new Proxy({}, {}),
		{ ...structuredClone(result.releases[0]), [Symbol("hidden")]: true },
		Object.defineProperty(structuredClone(result.releases[0]), "hidden", {
			value: true,
		}),
		{ ...structuredClone(result.releases[0]), assets: new Array(45) },
	]) {
		assert.throws(
			() => parseReleaseEvidence(value),
			/accessor|array|data|field|plain|proxy|snapshot|symbol/iu,
		);
	}
	assert.equal(invoked, false);
	assert.throws(
		() => semanticReleaseProjection(accessor),
		/accessor|data|field|plain|snapshot/iu,
	);
	assert.throws(
		() => semanticAssetProjection(accessor),
		/accessor|data|field|plain|snapshot/iu,
	);
});

test("strict evidence IDs accept only canonical positive decimal strings", async () => {
	const fixture = createDuplicateDraftConsolidationFixture();
	const result = await inspectEquivalentDrafts(INPUT(fixture));
	const invalid = [61436, 0, "0", "061436", "-1", "+1", " 1", "1 ", "1e3"];
	for (const value of invalid) {
		for (const mutate of [
			(evidence) => (evidence.id = value),
			(evidence) => (evidence.semantic.author.id = value),
			(evidence) => (evidence.assets[0].id = value),
			(evidence) => (evidence.assets[0].uploader.id = value),
		]) {
			const evidence = structuredClone(result.releases[0]);
			mutate(evidence);
			assert.throws(
				() => parseReleaseEvidence(evidence),
				/decimal|id|identity/iu,
			);
		}
	}
});

test("candidate identity is exact", async () => {
	const fixture = createDuplicateDraftConsolidationFixture();
	await assert.rejects(
		inspectEquivalentDrafts({
			...INPUT(fixture),
			candidate: { ...DUPLICATE_DRAFT_CANDIDATE, commitSha: "f".repeat(40) },
		}),
		/new Error|candidate|approved/iu,
	);
});

function mutateManifest(fixture, mutate) {
	const bytes = fixture.assetBytes(fixture.survivorId, "manifest.json");
	const manifest = JSON.parse(bytes.toString("utf8"));
	mutate(manifest);
	fixture.replaceAssetBytes(
		fixture.survivorId,
		"manifest.json",
		Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
		{ updateMetadata: true },
	);
}
