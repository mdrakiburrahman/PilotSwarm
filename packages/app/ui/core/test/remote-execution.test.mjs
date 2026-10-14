import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import { selectRemoteTargetPickerModal } from "../src/selectors.js";

function make(overrides = {}) {
    const created = [];
    const transport = {
        listSessions: async () => [],
        getSession: async () => null,
        subscribeSession: () => () => {},
        getRemoteExecutionConfig: () => ({ enabled: true, openOnStart: false }),
        listRemoteTargets: async () => [
            { id: "down-1", label: "down-1", available: false, listenerCount: 0 },
            { id: "up-1", label: "up-1", available: true, listenerCount: 1 },
        ],
        createSessionForAgent: async (agentName, options) => {
            created.push({ agentName, options });
            return { sessionId: "r1", agentId: agentName, title: options.title, status: "idle" };
        },
        ...overrides,
    };
    const store = createStore(appReducer, createInitialState());
    return { controller: new PilotSwarmUiController({ store, transport }), store, created };
}

test("the picker lists targets, preselecting the first with a listener", async () => {
    const { controller, store } = make();
    await controller.openRemoteExecutionPicker();
    const view = selectRemoteTargetPickerModal(store.getState());
    assert.equal(view.rows.length, 2);
    assert.equal(view.selectedRowIndex, 1);
    assert.equal(view.rows[0][0].text, "○ ");
});

test("confirming an available target starts a remote-operator chat bound to it", async () => {
    const { controller, store, created } = make();
    await controller.openRemoteExecutionPicker();
    await controller.confirmModal();
    assert.equal(store.getState().ui.modal, null);
    assert.equal(created.length, 1);
    assert.equal(created[0].agentName, "remote-operator");
    assert.match(created[0].options.initialPrompt, /Remote target: up-1\./);
});

test("an unavailable target cannot be started", async () => {
    const { controller, store, created } = make();
    await controller.openRemoteExecutionPicker();
    store.dispatch({ type: "ui/modalSelection", index: 0 });
    await controller.confirmModal();
    assert.equal(created.length, 0);
    assert.equal(store.getState().ui.modal?.type, "remoteTargetPicker");
});

test("without a provider the feature is off and the picker does not open", async () => {
    const { controller, store } = make({ getRemoteExecutionConfig: () => ({ enabled: false }) });
    assert.equal(controller.isRemoteExecutionEnabled(), false);
    await controller.openRemoteExecutionPicker();
    assert.equal(store.getState().ui.modal, null);
});
