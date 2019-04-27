"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const autorebase_1 = require("./autorebase");
const requireWriteAccessForOneTimeRebase = permission => permission === "admin" || permission === "write";
exports.requireWriteAccessForOneTimeRebase = requireWriteAccessForOneTimeRebase;
const createApplicationFunction = (options) => (app) => {
    app.log("App loaded");
    app.on([
        "check_run.completed",
        "issue_comment.created",
        "pull_request",
        "pull_request_review.submitted",
        "status",
    ], async (context) => {
        const { owner, repo } = context.repo();
        const event = {
            id: context.id,
            // @ts-ignore The event is of the good type because Autorebase only subscribes to a subset of webhooks.
            name: context.name,
            payload: context.payload,
        };
        const handlerResult = await options.handleEvent(event);
        const forceRebase = handlerResult === true;
        let action = { type: "nop" };
        try {
            action = await autorebase_1.autorebase({
                canRebaseOneTime: options.canRebaseOneTime,
                event,
                forceRebase,
                label: options.label,
                // The value is the good one even if the type doesn't match.
                octokit: context.github,
                owner,
                repo,
            });
        }
        catch (error) {
            action = { error, type: "failed" };
            throw error;
        }
        finally {
            context.log(action);
            if (action.type !== "nop") {
                await options.handleAction(action);
            }
        }
    });
};
exports.createApplicationFunction = createApplicationFunction;
