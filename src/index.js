"use strict";
const probot_serverless_now_1 = require("probot-serverless-now");
const app_1 = require("./app");
const nopHandler = () => Promise.resolve();
module.exports = probot_serverless_now_1.toLambda(app_1.createApplicationFunction({
    canRebaseOneTime: app_1.requireWriteAccessForOneTimeRebase,
    handleAction: nopHandler,
    handleEvent: nopHandler,
    label: "autorebase",
}));
