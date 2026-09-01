import { types as utilTypes } from "node:util";

const FACADES = new WeakMap();
const TRANSITIONS = new WeakMap();

export function registerConsolidationTransitionFacade(facade, armTransition) {
	if (
		facade === null ||
		typeof facade !== "object" ||
		utilTypes.isProxy(facade) ||
		!Object.isFrozen(facade) ||
		typeof armTransition !== "function" ||
		utilTypes.isProxy(armTransition) ||
		FACADES.has(facade)
	) {
		throw new TypeError("Consolidation transition registration is invalid");
	}
	const capability = Object.freeze(Object.create(null));
	FACADES.set(facade, capability);
	TRANSITIONS.set(capability, armTransition);
}

export function claimConsolidationTransitionFacade(facade) {
	const capability =
		facade !== null && typeof facade === "object"
			? FACADES.get(facade)
			: undefined;
	if (capability === undefined) {
		throw new TypeError(
			"Consolidation transition facade is absent, consumed, or untrusted",
		);
	}
	FACADES.delete(facade);
	return capability;
}

export function invokeConsolidationTransition(capability, input) {
	const armTransition =
		capability !== null && typeof capability === "object"
			? TRANSITIONS.get(capability)
			: undefined;
	if (armTransition === undefined) {
		throw new TypeError(
			"Consolidation transition capability is absent, consumed, or untrusted",
		);
	}
	TRANSITIONS.delete(capability);
	return armTransition(input);
}
