"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assert = require("assert");
// tslint:disable-next-line:no-var-requires (otherwise we get the error TS2497).
const promiseRetry = require("promise-retry");
const sleep = (milliseconds) => new Promise(resolve => {
    setTimeout(resolve, milliseconds);
});
exports.sleep = sleep;
const getPullRequestInfo = ({ debug, label, pullRequest: { base: { ref: base }, closed_at: closedAt, head: { ref: head, sha }, labels, mergeable, mergeable_state: mergeableState, merged, number: pullRequestNumber, }, }) => {
    const labelNames = labels.map(({ name }) => name);
    debug("pull request info", {
        base,
        closedAt,
        head,
        labelNames,
        mergeable,
        mergeableState,
        merged,
        pullRequestNumber,
        sha,
    });
    return {
        base,
        head,
        labeledAndOpenedAndRebaseable: labels.map(({ name }) => name).includes(label) &&
            closedAt === null &&
            // We used to look at the `rebaseable` flag sent by GitHub
            // but it's sometimes `false` even though the PR is actually rebaseable.
            mergeable,
        mergeableState: mergeableState,
        merged,
        pullRequestNumber,
        sha,
    };
};
const isMergeableStateKnown = ({ closed_at: closedAt, mergeable_state: mergeableState, }) => closedAt !== null || mergeableState !== "unknown";
const checkKnownMergeableState = async ({ debug, octokit, owner, pullRequestNumber, repo, }) => {
    debug("fetching mergeable state", { pullRequestNumber });
    const { data: pullRequest } = await octokit.pulls.get({
        number: pullRequestNumber,
        owner,
        repo,
    });
    const { closed_at: closedAt, mergeable_state: mergeableState } = pullRequest;
    debug("mergeable state", { closedAt, mergeableState, pullRequestNumber });
    assert(isMergeableStateKnown(pullRequest));
    return pullRequest;
};
const waitForKnownMergeableState = ({ debug, octokit, owner, pullRequestNumber, repo, }) => promiseRetry(async (retry) => {
    try {
        return await checkKnownMergeableState({
            debug,
            octokit,
            owner,
            pullRequestNumber,
            repo,
        });
    }
    catch (error) {
        debug("retrying to know mergeable state", { pullRequestNumber });
        return retry(error);
    }
}, { minTimeout: 500 });
exports.waitForKnownMergeableState = waitForKnownMergeableState;
const getPullRequestInfoWithKnownMergeableState = async ({ debug, label, octokit, owner, pullRequestNumber, repo, }) => {
    // Sometimes, a webhook is sent with `mergeable_state: 'clean'` when the
    // pull request actual mergeable state is `behind`.
    // Or with `mergeable_state: 'unstable'` when it's actually `behind` too.
    // Making a request to the GitHub API to retrieve the pull request details
    // will return the actual mergeable state.
    // Thus, we don't try to see if the pull request passed as an argument
    // has already a known mergeable state, we always ask the GitHub API for it.
    const pullRequestWithKnownMergeableState = await waitForKnownMergeableState({
        debug,
        octokit,
        owner,
        pullRequestNumber,
        repo,
    });
    return getPullRequestInfo({
        debug,
        label,
        pullRequest: pullRequestWithKnownMergeableState,
    });
};
exports.getPullRequestInfoWithKnownMergeableState = getPullRequestInfoWithKnownMergeableState;
const getPullRequestNumbers = (searchResults) => {
    if (searchResults["items"]) {
        return searchResults.items.map((item) => item.number);
    }
    else {
        return searchResults.number;
    }
};
const findOldestPullRequest = async ({ debug, extraSearchQualifiers, label, octokit, owner, predicate, repo, }) => {
    const query = `is:pr is:open label:"${label}" repo:${owner}/${repo} ${extraSearchQualifiers}`;
    debug("searching oldest matching pull request", { query });
    // Use the search endpoint to be able to filter on labels.
    const options = octokit.search.issuesAndPullRequests.endpoint.merge({
        order: "asc",
        q: query,
        sort: "created",
    });
    // Waiting a bit before to let GitHub make its data consistent.
    await sleep(1000);
    const searchResults = await octokit.paginate(options);
    const pullRequestNumbers = Array.prototype.concat(...searchResults.map(getPullRequestNumbers));
    debug({ pullRequestNumbers });
    const initialPromise = Promise.resolve(null);
    return pullRequestNumbers.reduce(async (promise, pullRequestNumber) => {
        const result = await promise;
        if (result) {
            return result;
        }
        debug({ pullRequestNumber });
        const pullRequest = await getPullRequestInfoWithKnownMergeableState({
            debug,
            label,
            octokit,
            owner,
            pullRequestNumber,
            repo,
        });
        const matchingPredicate = predicate(pullRequest);
        debug({ matchingPredicate, pullRequest });
        return matchingPredicate ? pullRequest : null;
    }, initialPromise);
};
exports.findOldestPullRequest = findOldestPullRequest;
const findAutorebaseablePullRequestMatchingSha = ({ debug, label, octokit, owner, repo, sha, }) => findOldestPullRequest({
    debug,
    extraSearchQualifiers: sha,
    label,
    octokit,
    owner,
    predicate: ({ labeledAndOpenedAndRebaseable, sha: pullRequestSha }) => labeledAndOpenedAndRebaseable && pullRequestSha === sha,
    repo,
});
exports.findAutorebaseablePullRequestMatchingSha = findAutorebaseablePullRequestMatchingSha;
// See the FAQ in README.md for why we do that.
const withLabelLock = async ({ action, debug, label, octokit, owner, pullRequestNumber, repo, }) => {
    try {
        debug("acquiring lock", pullRequestNumber);
        await octokit.issues.removeLabel({
            name: label,
            number: pullRequestNumber,
            owner,
            repo,
        });
    }
    catch (error) {
        debug("lock already acquired by another process", pullRequestNumber);
        return false;
    }
    debug("lock acquired", pullRequestNumber);
    await action();
    debug("releasing lock", pullRequestNumber);
    await octokit.issues.addLabels({
        labels: [label],
        number: pullRequestNumber,
        owner,
        repo,
    });
    debug("lock released", pullRequestNumber);
    return true;
};
exports.withLabelLock = withLabelLock;
