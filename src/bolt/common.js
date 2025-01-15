const assert = require('assert');
const voca = require('voca');

const { Admin, Hearts, Polls } = require('../core/index');
const { SLACKBOT, HOUR, YAY, NAY } = require('../constants');

// Utilities

exports.homeEndpoint = function (appName) {
  return {
    path: '/',
    method: [ 'GET' ],
    handler: async (_, res) => {
      res.writeHead(200);
      res.end(`Welcome to Chore Wheel - ${appName}!`);
    },
  };
};

exports.getUser = async function (app, oauth, userId) {
  return app.client.users.info({
    token: oauth.bot.token,
    user: userId,
  });
};

exports.isAdmin = async function (app, oauth, userId) {
  const { user } = await exports.getUser(app, oauth, userId);
  return user.is_admin;
};

exports.parseUrl = function (url) {
  url = url.startsWith('http') ? url : `https://${url}`;
  try {
    return new URL(url);
  } catch {}
};

// Entry points

exports.beginHome = function (appName, body, event) {
  const now = new Date();
  const houseId = body.team_id;
  const residentId = event.user;

  console.log(`${appName} home - ${houseId} x ${residentId}`);

  return { now, houseId, residentId };
};

exports.beginAction = function (actionName, body) {
  const now = new Date();
  const houseId = body.team.id;
  const residentId = body.user.id;

  console.log(`${actionName} - ${houseId} x ${residentId}`);

  return { now, houseId, residentId };
};

exports.beginCommand = function (commandName, command) {
  const now = new Date();
  const houseId = command.team_id;
  const residentId = command.user_id;

  console.log(`${commandName} - ${houseId} x ${residentId}`);

  return { now, houseId, residentId };
};

// Publishing

exports.replyEphemeral = async function (app, oauth, command, text) {
  const { channel_id: channelId, user_id: residentId } = command;
  return exports.postEphemeral(app, oauth, channelId, residentId, text);
};

exports.postEphemeral = async function (app, oauth, channelId, residentId, text) {
  return app.client.chat.postEphemeral({
    token: oauth.bot.token,
    channel: channelId,
    user: residentId,
    text,
  });
};

exports.postMessage = async function (app, oauth, channelId, text, blocks) {
  return app.client.chat.postMessage({
    token: oauth.bot.token,
    channel: channelId,
    text,
    blocks,
  });
};

exports.postReply = async function (app, oauth, channelId, ts, text, blocks) {
  return app.client.chat.postMessage({
    token: oauth.bot.token,
    channel: channelId,
    thread_ts: ts,
    text,
    blocks,
  });
};

exports.publishHome = async function (app, oauth, residentId, view) {
  await app.client.views.publish({
    token: oauth.bot.token,
    user_id: residentId,
    view,
  });
};

exports.openView = async function (app, oauth, triggerId, view) {
  return app.client.views.open({
    token: oauth.bot.token,
    trigger_id: triggerId,
    view,
  });
};

exports.pushView = async function (app, oauth, triggerId, view) {
  return app.client.views.push({
    token: oauth.bot.token,
    trigger_id: triggerId,
    view,
  });
};

exports.addReaction = async function (app, oauth, payload, emoji) {
  return app.client.reactions.add({
    token: oauth.bot.token,
    channel: payload.channel,
    timestamp: payload.event_ts,
    name: emoji,
  });
};

exports.getMessage = async function (app, oauth, channelId, ts) {
  return app.client.conversations.history({
    token: oauth.bot.token,
    channel: channelId,
    latest: ts,
    inclusive: true,
    limit: 1,
  });
};

// Internal tools

exports.uninstallApp = async function (app, appName, context) {
  console.log(`${appName} app_uninstalled - ${context.teamId}`);

  const { installationStore } = app.receiver.installer;
  await installationStore.deleteInstallation(context);
};

exports.setChannel = async function (app, oauth, confName, command) {
  if (!(await exports.isAdmin(app, oauth, command.user_id))) {
    await exports.replyAdminOnly(app, oauth, command);
    return;
  }

  let text;

  if (command.text === 'help') {
    text = 'Set the current channel as the events channel for the app. ' +
    'The app will use this channel to post polls and share public activity.';
  } else {
    const [ houseId, channelId ] = [ command.team_id, command.channel_id ];
    await Admin.updateHouseConf(houseId, confName, { channel: channelId });

    await app.client.conversations.join({ token: oauth.bot.token, channel: channelId });
    text = `App events channel set to *<#${channelId}>* :fire:`;
  }

  await exports.replyEphemeral(app, oauth, command, text);
};

exports.activateResident = async function (houseId, residentId, now) {
  await Admin.activateResident(houseId, residentId, now);
  await Hearts.initialiseResident(houseId, residentId, now);
};

exports.deactivateResident = async function (houseId, residentId) {
  await Admin.deactivateResident(houseId, residentId);
};

exports.getWorkspaceMembers = async function (app, oauth) {
  const { members } = await app.client.users.list({ token: oauth.bot.token });
  return members.filter(member => !(member.is_bot || member.id === SLACKBOT));
};

exports.pruneWorkspaceMembers = async function (app, oauth, houseId, now) {
  for (const member of (await exports.getWorkspaceMembers(app, oauth))) {
    await exports.pruneWorkspaceMember(houseId, member);
  }

  const residents = await Admin.getResidents(houseId, now);
  return `Pruned workspace with ${residents.length} active residents`;
};

exports.pruneWorkspaceMember = async function (houseId, member) {
  if (member.deleted) {
    return exports.deactivateResident(houseId, member.id);
  }
};

exports.syncWorkspaceChannels = async function (app, oauth) {
  const token = oauth.bot.token;
  const { channels: botChannels } = await app.client.users.conversations({ token });
  const { channels: workspaceChannels } = await app.client.conversations.list({ token, exclude_archived: true });

  const botChannelIds = botChannels
    .map(channel => channel.id);

  const workspaceChannelIds = workspaceChannels
    .filter(channel => !(channel.is_private || channel.is_archived || botChannelIds.includes(channel.id)))
    .map(channel => channel.id);

  for (const channelId of workspaceChannelIds) {
    await exports.joinChannel(app, oauth, channelId);
  }

  return `Synced workspace with ${workspaceChannels.length} public channels`;
};

exports.joinChannel = async function (app, oauth, channelId) {
  return app.client.conversations.join({ token: oauth.bot.token, channel: channelId });
};

exports.replyAdminOnly = function (app, oauth, command) {
  const text = ':warning: This function is admin-only :warning:';
  return exports.replyEphemeral(app, oauth, command, text);
};

exports.parseTitlecase = function (text) {
  return voca(text).trim().lowerCase().titleCase().value();
};

exports.parseLowercase = function (text) {
  return voca(text).trim().lowerCase().value();
};

exports.getInputBlock = function (body, blockIdx) {
  // https://api.slack.com/reference/interaction-payloads/views#view_submission_fields
  const realIdx = (blockIdx < 0) ? body.view.blocks.length + blockIdx : blockIdx;
  const blockId = body.view.blocks[realIdx].block_id;
  return body.view.state.values[blockId];
};

exports.feedbackLink = '<mailto:support@zaratan.world|Submit Feedback>';

// Vote processing

exports.updateVoteCounts = async function (app, oauth, body, action) {
  const now = new Date();
  const channelId = body.channel.id;
  const residentId = body.user.id;

  if (!(await Admin.isActive(residentId, now))) {
    const text = ':warning: Inactive residents are not allowed to vote :warning:';
    await exports.postEphemeral(app, oauth, channelId, residentId, text);
    return;
  }

  const { pollId, value } = JSON.parse(action.value);
  await Polls.submitVote(pollId, residentId, now, value);

  // Update the vote counts
  const { yays, nays } = await Polls.getPollResultCounts(pollId);
  const voteBlock = body.message.blocks.length - 1;
  body.message.token = oauth.bot.token;
  body.message.channel = channelId;
  body.message.blocks[voteBlock].elements = exports.makeVoteButtons(pollId, yays, nays);

  await app.client.chat.update(body.message);
};

exports.updateVoteResults = async function (app, oauth, pollId, now) {
  const { metadata } = await Polls.getPoll(pollId);

  assert(metadata.channel && metadata.ts, `No message found for pollId ${pollId}`);

  const body = await exports.getMessage(app, oauth, metadata.channel, metadata.ts);
  const message = body.messages[0];

  // Parse current vote counts;
  const voteBlock = message.blocks.length - 1;
  const voteButtons = message.blocks[voteBlock].elements;
  const { yays } = JSON.parse(voteButtons[0].value);
  const { nays } = JSON.parse(voteButtons[1].value);

  const valid = await Polls.isPollValid(pollId, now);
  const result = valid ? 'passed' : 'failed';
  const emoji = valid ? ' :white_check_mark: ' : ' :x: '; // Extra spacing
  const resultText = `Vote *${result}*, *${yays}* to *${nays}* ${emoji}`;

  // Update the results
  message.token = oauth.bot.token;
  message.channel = metadata.channel;
  message.blocks[voteBlock] = exports.blockSection(resultText);

  await app.client.chat.update(message);
};

exports.makeVoteText = function (minVotes, pollLength) {
  return `At least *${minVotes} upvote(s)* are needed to pass, ` +
    `voting closes in *${pollLength / HOUR} hours*`;
};

exports.makeVoteButtons = function (pollId, yays, nays) {
  return [
    {
      type: 'button',
      action_id: 'poll-vote-up',
      text: exports.blockPlaintext(`:+1: (${yays})`),
      value: JSON.stringify({ pollId, yays, value: YAY }),
    },
    {
      type: 'button',
      action_id: 'poll-vote-down',
      text: exports.blockPlaintext(`:-1: (${nays})`),
      value: JSON.stringify({ pollId, nays, value: NAY }),
    },
  ];
};

exports.makeForceInput = function () {
  const options = [
    { value: 'true', text: exports.blockMarkdown('Force (no vote)') },
    { value: 'false', text: exports.blockMarkdown('Don\'t force (regular vote)') },
  ];

  return exports.blockInput(
    '[Admin only] Would you like to force this change?',
    {
      type: 'radio_buttons',
      action_id: 'force',
      initial_option: options[1],
      options,
    },
  );
};

// Block may or may not exist
exports.getForceInput = function (block) {
  if (block && block.force) {
    return block.force.selected_option.value === 'true';
  } else {
    return false;
  }
};

// Block rendering

exports.blockPlaintext = function (text) {
  return { type: 'plain_text', emoji: true, text };
};

exports.blockMarkdown = function (text) {
  return { type: 'mrkdwn', text };
};

exports.blockHeader = function (text) {
  return { type: 'header', text: exports.blockPlaintext(text) };
};

exports.blockSection = function (text) {
  return { type: 'section', text: exports.blockMarkdown(text) };
};

exports.blockButton = function (action, text) {
  return { type: 'button', action_id: action, text: exports.blockPlaintext(text) };
};

exports.blockDivider = function () {
  return { type: 'divider' };
};

exports.blockActions = function (elements) {
  return { type: 'actions', elements };
};

exports.blockInput = function (label, element, optional = false) {
  return { type: 'input', label: exports.blockPlaintext(label), element, optional };
};

exports.blockOptionGroup = function (label, options) {
  return { label: exports.blockPlaintext(label), options };
};

// Show only human users in multi_conversations_select
exports.userFilter = { include: [ 'im' ], exclude_bot_users: true };

exports.CLOSE = exports.blockPlaintext('Cancel');
exports.BACK = exports.blockPlaintext('Back');
exports.NEXT = exports.blockPlaintext('Next');
exports.SUBMIT = exports.blockPlaintext('Submit');
