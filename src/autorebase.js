"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const createDebug = require("debug");
const github_rebase_1 = require("github-rebase");
const git_1 = require("shared-github-internals/lib/git");
const utils_1 = require("./utils");
const globalDebug = createDebug("autorebase");
const merge = async ({ debug, head, octokit, owner, pullRequestNumber, repo, }) => {
    debug("merging", pullRequestNumber);
    await octokit.pulls.merge({
        merge_method: "merge",
        number: pullRequestNumber,
        owner,
        repo,
    });
    debug("merged", pullRequestNumber);
    debug("deleting reference", head);
    await git_1.deleteRef({ octokit, owner, ref: head, repo });
    debug("reference deleted", head);
    return {
        pullRequestNumber,
        type: "merge",
    };
};
const rebase = async ({ debug, label, octokit, owner, pullRequestNumber, repo, }) => {
    debug("rebasing", pullRequestNumber);
    try {
        const doRebase = async () => {
            await github_rebase_1.rebasePullRequest({
                octokit,
                owner,
                pullRequestNumber,
                repo,
            });
        };
        if (label) {
            const rebased = await utils_1.withLabelLock({
                action: doRebase,
                debug,
                label,
                octokit,
                owner,
                pullRequestNumber,
                repo,
            });
            if (!rebased) {
                debug("other process already rebasing, aborting", pullRequestNumber);
                return { pullRequestNumber, type: "abort" };
            }
        }
        else {
            await doRebase();
        }
        debug("rebased", pullRequestNumber);
        return { pullRequestNumber, type: "rebase" };
    }
    catch (error) {
        const message = "rebase failed";
        debug(message, error);
        const { data: { base: { ref: baseRef }, head: { ref: headRef }, }, } = await octokit.pulls.get({ number: pullRequestNumber, owner, repo });
        await octokit.issues.createComment({
            body: [
                `The rebase failed:`,
                "",
                "```",
                error.message,
                "```",
                "To rebase manually, run these commands in your terminal:",
                "```bash",
                "# Fetch latest updates from GitHub.",
                "git fetch",
                "# Create new working tree.",
                `git worktree add .worktrees/rebase ${headRef}`,
                "# Navigate to the new directory.",
                "cd .worktrees/rebase",
                "# Rebase and resolve the likely conflicts.",
                `git rebase --interactive --autosquash ${baseRef}`,
                "# Push the new branch state to GitHub.",
                `git push --force`,
                "# Go back to the original working tree.",
                "cd ../..",
                "# Delete the working tree.",
                "git worktree remove .worktrees/rebase",
                "```",
            ].join("\n"),
            number: pullRequestNumber,
            owner,
            repo,
        });
        throw new Error(message);
    }
};
const findAndRebasePullRequestOnSameBase = async ({ base, debug, label, octokit, owner, repo, }) => {
    debug("searching for pull request to rebase on same base", base);
    const pullRequest = await utils_1.findOldestPullRequest({
        debug,
        extraSearchQualifiers: `base:${base}`,
        label,
        octokit,
        owner,
        predicate: ({ mergeableState }) => mergeableState === "behind",
        repo,
    });
    debug("pull request to rebase on same base", pullRequest);
    return pullRequest
        ? rebase({
            debug,
            label,
            octokit,
            owner,
            pullRequestNumber: pullRequest.pullRequestNumber,
            repo,
        })
        : { type: "nop" };
};
const autorebasePullRequest = async ({ debug, forceRebase, label, octokit, owner, pullRequest, repo, }) => {
    const shouldBeAutosquashed = await github_rebase_1.needAutosquashing({
        octokit,
        owner,
        pullRequestNumber: pullRequest.pullRequestNumber,
        repo,
    });
    debug("autorebasing pull request", {
        forceRebase,
        pullRequest,
        shouldBeAutosquashed,
    });
    const shouldBeRebased = forceRebase ||
        shouldBeAutosquashed ||
        pullRequest.mergeableState === "behind";
    if (shouldBeRebased) {
        return rebase({
            debug,
            label,
            octokit,
            owner,
            pullRequestNumber: pullRequest.pullRequestNumber,
            repo,
        });
    }
    if (pullRequest.mergeableState === "clean") {
        return merge({
            debug,
            head: pullRequest.head,
            octokit,
            owner,
            pullRequestNumber: pullRequest.pullRequestNumber,
            repo,
        });
    }
    return { type: "nop" };
};
const rebaseOneTime = async ({ canRebaseOneTime, debug, octokit, owner, pullRequestNumber, repo, username, }) => {
    const { data: { permission }, } = await octokit.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username,
    });
    if (canRebaseOneTime(permission)) {
        await rebase({
            debug,
            octokit,
            owner,
            pullRequestNumber,
            repo,
        });
        return { pullRequestNumber, type: "rebase" };
    }
    else {
        debug("denied one-time rebase");
        await octokit.issues.createComment({
            body: "Rebase commands can only be submitted by collaborators with write permission on the repository.",
            number: pullRequestNumber,
            owner,
            repo,
        });
        return { pullRequestNumber, type: "deny-one-time-rebase" };
    }
};
const autorebase = async ({ canRebaseOneTime, event, forceRebase, label, octokit, owner, repo, }) => {
    const debug = globalDebug.extend(event.id);
    debug("received event", { event, label });
    if (event.name === "issue_comment") {
        const { comment: { body: comment, user: { login: username }, }, issue: { number: pullRequestNumber, pull_request: pullRequestUrls }, } = event.payload;
        if ([`/${label}`, "/rebase"].includes(comment.trim()) &&
            pullRequestUrls !== undefined) {
            debug("handling one-time rebase command", { comment, username });
            return rebaseOneTime({
                canRebaseOneTime,
                debug,
                octokit,
                owner,
                pullRequestNumber,
                repo,
                username,
            });
        }
    }
    else if (event.name === "check_run" || event.name === "status") {
        const sha = event.name === "check_run"
            ? event.payload.check_run.head_sha
            : event.payload.sha;
        debug("handling check_run or status event", { sha });
        const pullRequest = await utils_1.findAutorebaseablePullRequestMatchingSha({
            debug,
            label,
            octokit,
            owner,
            repo,
            sha,
        });
        if (pullRequest) {
            debug("autorebaseable pull request matching sha", pullRequest);
            if (pullRequest.mergeableState === "clean") {
                return merge({
                    debug,
                    head: pullRequest.head,
                    octokit,
                    owner,
                    pullRequestNumber: pullRequest.pullRequestNumber,
                    repo,
                });
            }
            else if (pullRequest.mergeableState === "blocked") {
                // Happens when an autorebaseable pull request gets blocked by an error status.
                // Assuming that the autorebase label was added on a pull request behind but with green statuses,
                // it means that the act of rebasing the pull request made it unmergeable.
                // Some manual intervention will have to be done on the pull request to unblock it.
                // In the meantime, in order not to be stuck,
                // Autorebase will try to rebase another pull request based on the same branch.
                return findAndRebasePullRequestOnSameBase({
                    base: pullRequest.base,
                    debug,
                    label,
                    octokit,
                    owner,
                    repo,
                });
            }
        }
    }
    else {
        const { name, payload: { action, pull_request: { number: pullRequestNumber }, }, } = event;
        const { closed_at: closedAt, mergeable, merged } = event.name === "pull_request"
            ? event.payload.pull_request
            : { closed_at: null, mergeable: null, merged: null };
        const isAutorebaseSamePullRequestEvent = event.name === "pull_request" &&
            (action === "opened" ||
                action === "synchronize" ||
                (event.payload.action === "labeled" &&
                    event.payload.label.name === label)) &&
            (mergeable || forceRebase) &&
            closedAt === null;
        const isRebasePullRequestOnSameBaseEvent = name === "pull_request" && action === "closed" && merged;
        const isMergeEvent = name === "pull_request_review";
        debug({
            action,
            closedAt,
            isAutorebaseSamePullRequestEvent,
            isMergeEvent,
            isRebasePullRequestOnSameBaseEvent,
            mergeable,
            merged,
            name,
        });
        if (isAutorebaseSamePullRequestEvent ||
            isRebasePullRequestOnSameBaseEvent ||
            isMergeEvent) {
            const pullRequest = await utils_1.getPullRequestInfoWithKnownMergeableState({
                debug,
                label,
                octokit,
                owner,
                pullRequestNumber,
                repo,
            });
            debug("pull request with known mergeable state", pullRequest);
            if (isAutorebaseSamePullRequestEvent) {
                if (forceRebase || pullRequest.labeledAndOpenedAndRebaseable) {
                    if (!pullRequest.labeledAndOpenedAndRebaseable) {
                        debug("force rebasing");
                    }
                    return autorebasePullRequest({
                        debug,
                        forceRebase,
                        label,
                        octokit,
                        owner,
                        pullRequest,
                        repo,
                    });
                }
            }
            if (isRebasePullRequestOnSameBaseEvent) {
                return findAndRebasePullRequestOnSameBase({
                    base: pullRequest.base,
                    debug,
                    label,
                    octokit,
                    owner,
                    repo,
                });
            }
            if (pullRequest.labeledAndOpenedAndRebaseable) {
                return merge({
                    debug,
                    head: pullRequest.head,
                    octokit,
                    owner,
                    pullRequestNumber,
                    repo,
                });
            }
        }
    }
    debug("nop");
    return { type: "nop" };
};
exports.autorebase = autorebase;
