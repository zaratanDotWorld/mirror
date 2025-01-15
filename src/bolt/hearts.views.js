const { heartsPollLength, heartsCriticalNum, heartsMinPctInitial, heartsMinPctCritical } = require('../config');

const common = require('./common');

const TITLE = common.blockPlaintext('Hearts');
const DOCS_URL = 'https://docs.chorewheel.zaratan.world/en/latest/tools/hearts.html';

exports.heartEmoji = function (numHearts) {
  let emoji;
  if (numHearts <= 0) {
    emoji = ':skull_and_crossbones:';
  } else if (numHearts <= 2) {
    emoji = ':broken_heart:';
  } else if (numHearts <= 5) {
    emoji = ':heart:';
  } else {
    emoji = ':heart_on_fire:';
  }

  let text = emoji.repeat(Math.max(1, Math.floor(numHearts)));
  text += (numHearts % 1 > 0) ? ':heavy_plus_sign:' : '';
  return text;
};

// Home views

exports.heartsIntroView = function () {
  const header = ':wave::skin-tone-4: Thanks for installing Hearts!';

  const instructions = `
*Follow these steps* to get set up (must be a workspace admin).
_Setup is easiest if everyone is in the same place, but it's not strictly necessary._

*1.* *Invite* all housemates to the Slack, and wait for them to join.

*2.* Set an events channel by calling \`/hearts-channel\`, which *unlocks the app*.

That's it! Just sit back and watch the magic happen :sparkles:

_For more details on *Hearts* functionality, read the <${DOCS_URL}|manual>._
`;

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(instructions));

  return {
    type: 'home',
    blocks,
  };
};

exports.heartsHomeView = function (isActive, numHearts, maxHearts) {
  const header = 'Welcome to Hearts';
  const textA = `We use *<${DOCS_URL}|Hearts>* to keep each other accountable.\n\n` +
    'Everyone starts with *5 hearts*. ' +
    'We lose hearts when we fail to uphold our commitments, ' +
    'and we regain hearts *over time* or by earning *karma* :sparkles:';
  const textB = (isActive)
    ? `You have *${numHearts} / ${maxHearts}* hearts: ${exports.heartEmoji(numHearts)}`
    : '*You are exempt from hearts!* :balloon:';

  const actions = [];
  actions.push(common.blockButton('hearts-board', ':two_hearts: See hearts'));
  if (isActive) {
    actions.push(common.blockButton('hearts-karma', ':sparkles: Give karma'));
    actions.push(common.blockButton('hearts-challenge', ':fencer: Settle a dispute'));
  }

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(textA));
  blocks.push(common.blockSection(common.feedbackLink));
  blocks.push(common.blockDivider());
  blocks.push(common.blockSection(textB));
  blocks.push(common.blockActions(actions));

  return {
    type: 'home',
    blocks,
  };
};

// Challenge flow

exports.heartsChallengeView = function (numResidents) {
  const initialQuorum = Math.ceil(numResidents * heartsMinPctInitial);
  const criticalQuorum = Math.ceil(numResidents * heartsMinPctCritical);
  const resolutionUrl = 'https://docs.chorewheel.zaratan.world/en/latest/practices/conflict-resolution.html';

  const header = 'Resolve a dispute';
  const mainText = 'If prior attempts at mediating a conflict have failed, it may be time to raise a public dispute.\n\n' +
    'Choose someone to challenge, a number of hearts to take away, and explain the circumstance. ' +
    'The dispute will go to a house vote, and the loser (potentially you) will lose hearts.\n\n' +
    `To succeed, you will need a minimum of *${initialQuorum} upvotes*. ` +
    `If the challengee will end up with less than *${heartsCriticalNum} hearts*, ` +
    `you will need a minimum of *${criticalQuorum} upvotes*. ` +
    'So please make sure you\'ve spoken to others about the issue before raising a dispute.\n\n' +
    `*<${resolutionUrl}|See here>* for more information about conflict resolution.`;

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockInput(
    'Challengee',
    {
      action_id: 'challengee',
      type: 'users_select',
      placeholder: common.blockPlaintext('Choose a resident'),
    },
  ));
  blocks.push(common.blockInput(
    'Number of hearts',
    {
      action_id: 'hearts',
      type: 'static_select',
      placeholder: common.blockPlaintext('Select a number'),
      options: [
        { value: '1', text: common.blockPlaintext('1') },
        { value: '2', text: common.blockPlaintext('2') },
        { value: '3', text: common.blockPlaintext('3') },
      ],
      initial_option: { value: '1', text: common.blockPlaintext('1') },
    },
  ));
  blocks.push(common.blockInput(
    'Circumstance',
    {
      action_id: 'circumstance',
      type: 'plain_text_input',
      multiline: true,
      placeholder: common.blockPlaintext('Explain the circumstance as best you can'),
    },
  ));

  return {
    type: 'modal',
    callback_id: 'hearts-challenge-callback',
    title: TITLE,
    close: common.CLOSE,
    submit: common.SUBMIT,
    blocks,
  };
};

exports.heartsChallengeCallbackView = function (challenge, minVotes, circumstance) {
  const mainText = `*<@${challenge.challengerId}>* challenged *<@${challenge.challengeeId}>* ` +
    `for *${challenge.value} heart(s)*, due to the following circumstance:`;

  const blocks = [];
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockSection(circumstance));
  blocks.push(common.blockSection(common.makeVoteText(minVotes, heartsPollLength)));
  blocks.push(common.blockActions(common.makeVoteButtons(challenge.pollId, 1, 0)));
  return blocks;
};

exports.heartsBoardView = function (hearts) {
  const header = 'Current hearts';
  const mainText = 'The baseline is *five hearts*. ' +
    'Anyone with *less* will regenerate at a rate of *¼ per month*, ' +
    'and anyone with *more* will fade at *¼ per month*, ' +
    'until they reach five.';

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockDivider());

  hearts.forEach((heart) => {
    blocks.push(common.blockSection(`${exports.heartEmoji(heart.sum)} <@${heart.residentId}>`));
  });

  return {
    type: 'modal',
    title: TITLE,
    close: common.CLOSE,
    blocks,
  };
};

// Karma flow

exports.heartsKarmaView = function () {
  const header = 'Give karma';
  const mainText = 'You can give someone good karma for any reason. ' +
    'Every month, the people with the most karma get bonus hearts. \n\n' +
    '_You can also give karma by "++"\'ing someone in chat: *@Name ++*_\n\n ';

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockInput(
    'Recipient',
    {
      action_id: 'recipient',
      type: 'users_select',
      placeholder: common.blockPlaintext('Choose a resident'),
    },
  ));
  blocks.push(common.blockInput(
    'Circumstance',
    {
      action_id: 'circumstance',
      type: 'plain_text_input',
      placeholder: common.blockPlaintext('Why are you giving them karma?'),
    },
  ));

  return {
    type: 'modal',
    callback_id: 'hearts-karma-callback',
    title: TITLE,
    close: common.CLOSE,
    submit: common.SUBMIT,
    blocks,
  };
};
