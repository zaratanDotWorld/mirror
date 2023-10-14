const { pointsPerResident, achievementBase, choresPollLength, choresProposalPollLength, penaltyIncrement } = require('../config');

const common = require('./common');

// Chores views

const TITLE = common.blockPlaintext('Chores');

exports.choresHomeView = function (balance, owed, numActive, exempt) {
  const progressEmoji = (owed - balance < penaltyIncrement) ? ':white_check_mark:' : ':muscle::skin-tone-4:';
  const docsUrl = 'https://github.com/zaratanDotWorld/mirror/wiki/Chores';

  const header = 'Welcome to Chores';
  const textA = `We use *<${docsUrl}|Chores>* to keep the house a nice place to live.\n\n` +
    'Instead of a chore wheel or schedule, everyone owes *100 points* per month (UTC time). ' +
    'You earn points by doing chores you want, on your terms.\n\n' +
    'The points for a chore go up every hour until someone claims them. ' +
    'If you feel a chore should be worth more (or less), you can change the speed at which it gains points.';
  const textB = (exempt)
    ? '*You are exempt from chores!* :tada:'
    : `You've earned *${balance.toFixed(0)} / ${owed.toFixed(0)} points* this month ${progressEmoji}`;
  const textC = `There are *${numActive} people* around today :sunny:`;

  const actions = [];
  if (!exempt) {
    actions.push(common.blockButton('chores-claim', 'Claim a chore'));
    actions.push(common.blockButton('chores-break', 'Take a break'));
    actions.push(common.blockButton('chores-gift', 'Gift your points'));
    actions.push(common.blockButton('chores-propose', 'Edit chores list'));
  }
  actions.push(common.blockButton('chores-rank', 'Set chore speeds'));

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(textA));
  blocks.push(common.blockDivider());
  blocks.push(common.blockSection(textB));
  blocks.push(common.blockSection(textC));
  blocks.push(common.blockActions(actions));

  return {
    type: 'home',
    blocks,
  };
};

exports.choresClaimView = function (chores) {
  const header = 'Claim a chore';
  const mainText = 'Claims are verified by the house and require at least *2 upvotes* (including yours). ' +
    'Posting pictures in the channel or thread will help others check your work.';

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockSection('*Chore to claim*'));
  blocks.push(common.blockActions([
    {
      type: 'static_select',
      action_id: 'chores-claim-2',
      placeholder: common.blockPlaintext('Choose a chore'),
      options: chores.map((chore) => {
        return {
          value: JSON.stringify({ id: chore.id }),
          text: common.blockPlaintext(`${chore.name} - ${chore.value.toFixed(0)} points`),
        };
      }),
    },
  ]));

  return {
    type: 'modal',
    title: TITLE,
    close: common.CLOSE,
    blocks,
  };
};

exports.choresClaimView2 = function (chore) {
  const metadata = JSON.stringify({ id: chore.id, name: chore.name });
  const header = 'Claim a chore';

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(`*${chore.name}*`));
  blocks.push(common.blockSection(chore.metadata.description || ''));

  return {
    type: 'modal',
    callback_id: 'chores-claim-callback',
    private_metadata: metadata,
    title: TITLE,
    close: common.CLOSE,
    submit: common.SUBMIT,
    blocks,
  };
};

exports.getAchievement = function (totalPoints) {
  if (totalPoints >= achievementBase * 5 * 5) {
    return ':first_place_medal:';
  } else if (totalPoints >= achievementBase * 5) {
    return ':second_place_medal:';
  } else if (totalPoints >= achievementBase) {
    return ':third_place_medal:';
  } else {
    return '';
  }
};

exports.getSparkles = function (monthlyPoints) {
  const numSparkles = Math.floor(monthlyPoints / (pointsPerResident / 4));
  return ':sparkles:'.repeat(numSparkles);
};

exports.choresClaimCallbackView = function (claim, choreName, totalPoints, monthlyPoints) {
  const achievement = exports.getAchievement(totalPoints);
  const sparkles = exports.getSparkles(monthlyPoints);

  const mainText = `*<@${claim.claimedBy}>* did *${choreName}* for ` +
    `*${claim.value.toFixed(0)} points* ${achievement}${sparkles}`;

  const blocks = [];
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockSection(common.makeVoteText(2, choresPollLength)));
  blocks.push(common.blockActions(common.makeVoteButtons(claim.pollId, 1, 0)));
  return blocks;
};

exports.choresRankView = function () {
  const header = 'Set chore speeds';
  const mainText = 'If you feel a chore should be worth more (or less), you can adjust it\'s *speed*. ' +
    'The *faster* a chore is, the more points it will be worth over time.\n\n' +
    'Speed-setting is a *cumulative* process, where every input makes a difference. ' +
    'It is also an *ongoing, collaborative* process: you can make small (or large) changes _at any time_, ' +
    'and encourage others to do the same.\n\n' +
    'First, decide whether you want to *speed up* or *slow down* a chore.';

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockActions([
    {
      type: 'radio_buttons',
      action_id: 'chores-rank-2',
      options: [
        { value: 'faster', text: common.blockMarkdown('*Speed up a chore* (worth more over time)') },
        { value: 'slower', text: common.blockMarkdown('*Slow down a chore* (worth less over time)') },
      ],
    },
  ]));

  return {
    type: 'modal',
    title: TITLE,
    close: common.CLOSE,
    blocks,
  };
};

exports.choresRankView2 = function (direction, choreRankings) {
  const mappedChoreRankings = choreRankings.map((chore) => {
    const choreSpeed = Math.round(chore.ranking * 1000);
    return {
      value: JSON.stringify({ id: chore.id, name: chore.name, speed: choreSpeed }),
      text: common.blockPlaintext(`${chore.name} - ${choreSpeed} ppt`),
    };
  });

  const header = 'Set chore speeds';
  const mainText = 'Choose chores to update. ' +
    'Chore speeds are measured in *points-per-thousand* (ppt) and always add up to *1000*. ' +
    'A ppt of *0* means a chore gets no points, while a ppt of *1000* means a chore gets _all_ the points.\n\n' +
    'You can think of updating as "taking" speed from some chores and giving it to others, ' +
    'since something must get slower for something to get faster (and vice versa).\n\n' +
    '*Some things to keep in mind:*\n\n' +
    '*1.* Taking from *more chores* has a bigger effect.\n' +
    '*2.* Taking from *faster chores* has a bigger effect.\n' +
    '*3.* *More participants* have a bigger effect.';

  const textA = direction === 'faster'
    ? 'Chore to speed up (worth more over time)'
    : 'Chore to slow down (worth less over time)';
  const textB = direction === 'faster'
    ? 'Chores to slow down (worth less over time)'
    : 'Chores to speed up (worth more over time)';

  const subTextA = direction === 'faster'
    ? 'Choose a chore to be worth more'
    : 'Choose a chore to be worth less';
  const subTextB = direction === 'faster'
    ? 'Choose some chores to be worth less'
    : 'Choose some chores to be worth more';

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockDivider());
  blocks.push(common.blockInput(
    textA,
    {
      action_id: 'chores',
      type: 'static_select',
      placeholder: common.blockPlaintext(subTextA),
      options: mappedChoreRankings,
    },
  ));
  blocks.push(common.blockInput(
    textB,
    {
      action_id: 'chores',
      type: 'multi_static_select',
      placeholder: common.blockPlaintext(subTextB),
      options: mappedChoreRankings,
    },
  ));

  return {
    type: 'modal',
    callback_id: 'chores-rank-callback',
    private_metadata: direction,
    title: TITLE,
    close: common.CLOSE,
    submit: common.SUBMIT,
    blocks,
  };
};

exports.choresBreakView = function (currentTime) {
  const formattedTime = `${currentTime.getFullYear()}-${currentTime.getMonth() + 1}-${currentTime.getDate()}`;

  const header = 'Take a break';
  const mainText = 'Take a chore break when you go out of town, ' +
    'and you won\'t owe points for the days that you\'re gone.\n\n' +
    'Breaks must be at least *3 days long* and can\'t be added retroactively, so don\'t forget!';

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockInput(
    'Day you leave',
    {
      action_id: 'date',
      type: 'datepicker',
      initial_date: formattedTime,
      placeholder: common.blockPlaintext('Select a date'),
    },
  ));
  blocks.push(common.blockInput(
    'Day you return',
    {
      action_id: 'date',
      type: 'datepicker',
      initial_date: formattedTime,
      placeholder: common.blockPlaintext('Select a date'),
    },
  ));
  blocks.push(common.blockInput(
    'Circumstance',
    {
      action_id: 'circumstance',
      type: 'plain_text_input',
      placeholder: common.blockPlaintext('Tell us where you\'re going'),
    },
  ));

  return {
    type: 'modal',
    callback_id: 'chores-break-callback',
    title: TITLE,
    close: common.CLOSE,
    submit: common.SUBMIT,
    blocks,
  };
};

exports.choresGiftView = function (currentBalance) {
  const header = 'Gift chore points';
  const mainText = 'Gift someone points from your balance. ' +
    `You have *${currentBalance.toFixed(0)} points* to gift.`;

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
    'Points',
    {
      action_id: 'points',
      type: 'number_input',
      min_value: '1',
      is_decimal_allowed: false,
      placeholder: common.blockPlaintext('Enter a number'),
    },
  ));
  blocks.push(common.blockInput(
    'Circumstance',
    {
      action_id: 'circumstance',
      type: 'plain_text_input',
      placeholder: common.blockPlaintext('Tell us why you\'re giving the gift'),
    },
  ));

  return {
    type: 'modal',
    callback_id: 'chores-gift-callback',
    private_metadata: currentBalance.toString(),
    title: TITLE,
    close: common.CLOSE,
    submit: common.SUBMIT,
    blocks,
  };
};

// Chore proposals

exports.choresProposeView = function (minVotes) {
  const header = 'Edit chores list';
  const mainText = 'Chores are not set in stone. ' +
    'If you believe things could be flowing better, consider *adding, removing, or changing* some chores. ' +
    `As a major house decision, a minimum of *${minVotes} upvote(s)* are required.\n\n` +
    'When defining chores, a key challenge is finding the right "size". ' +
    'Bigger chores are harder to do, but easier to prioritize and evaluate. ' +
    'Smaller chores are the opposite -- easier to do, but harder to prioritize and evaluate.\n\n' +
    'Ultimately, finding the right balance is an ongoing discovery process.';

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockActions([
    {
      type: 'radio_buttons',
      action_id: 'chores-propose-2',
      options: [
        { value: 'add', text: common.blockMarkdown('*Add* a new chore') },
        { value: 'edit', text: common.blockMarkdown('*Change* an existing chore') },
        { value: 'delete', text: common.blockMarkdown('*Remove* an existing chore') },
      ],
    },
  ]));

  return {
    type: 'modal',
    title: TITLE,
    close: common.CLOSE,
    blocks,
  };
};

exports.choresProposeEditView = function (chores) {
  const header = 'Edit chores list';
  const mainText = 'Change an existing chore.';

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockActions([
    {
      type: 'static_select',
      action_id: 'chores-propose-edit',
      placeholder: common.blockPlaintext('Choose a chore'),
      options: chores.map((chore) => {
        return {
          value: JSON.stringify({ id: chore.id }),
          text: common.blockPlaintext(chore.name),
        };
      }),
    },
  ]));

  return {
    type: 'modal',
    title: TITLE,
    close: common.CLOSE,
    blocks,
  };
};

// NOTE: used for both add and edit flows
exports.choresProposeAddView = function (chore) {
  const header = 'Edit chores list';
  let metadata, mainText;

  if (chore) {
    metadata = JSON.stringify({ change: 'edit', chore: { id: chore.id, name: chore.name } });
    mainText = 'Change an existing chore.';
  } else {
    metadata = JSON.stringify({ change: 'add' });
    mainText = 'Add a new chore.';
  }

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockInput(
    'Name',
    {
      action_id: 'name',
      type: 'plain_text_input',
      initial_value: (chore) ? chore.name : undefined,
      placeholder: common.blockPlaintext('Name of the chore'),
    },
  ));
  blocks.push(common.blockInput(
    'Description',
    {
      action_id: 'description',
      type: 'plain_text_input',
      multiline: true,
      initial_value: (chore) ? chore.metadata.description : undefined,
      placeholder: common.blockPlaintext('Describe the chore (bullet points work well)'),
    },
  ));

  return {
    type: 'modal',
    callback_id: 'chores-propose-callback',
    private_metadata: metadata,
    title: TITLE,
    close: common.CLOSE,
    submit: common.SUBMIT,
    blocks,
  };
};

exports.choresProposeDeleteView = function (chores) {
  const metadata = JSON.stringify({ change: 'delete' });
  const header = 'Edit chores list';
  const mainText = 'Remove an existing chore.';

  const blocks = [];
  blocks.push(common.blockHeader(header));
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockInput(
    'Chore to remove',
    {
      action_id: 'chore',
      type: 'static_select',
      placeholder: common.blockPlaintext('Choose a chore'),
      options: chores.map((chore) => {
        return {
          value: JSON.stringify({ id: chore.id, name: chore.name }),
          text: common.blockPlaintext(chore.name),
        };
      }),
    },
  ));

  return {
    type: 'modal',
    callback_id: 'chores-propose-callback',
    private_metadata: metadata,
    title: TITLE,
    close: common.CLOSE,
    submit: common.SUBMIT,
    blocks,
  };
};

exports.choresProposeCallbackView = function (metadata, proposal, minVotes) {
  let mainText;
  switch (metadata.change) {
    case 'add':
      mainText = `*<@${proposal.proposedBy}>* wants to *add* a chore:`;
      break;
    case 'edit':
      mainText = `*<@${proposal.proposedBy}>* wants to *edit* the *${metadata.chore.name}* chore:`;
      break;
    case 'delete':
      mainText = `*<@${proposal.proposedBy}>* wants to *delete* a chore:`;
      break;
  }

  const blocks = [];
  blocks.push(common.blockSection(mainText));
  blocks.push(common.blockSection(`*${proposal.name}*`));

  if (proposal.metadata.description) {
    blocks.push(common.blockSection(proposal.metadata.description));
  }

  blocks.push(common.blockSection(common.makeVoteText(minVotes, choresProposalPollLength)));
  blocks.push(common.blockActions(common.makeVoteButtons(proposal.pollId, 1, 0)));
  return blocks;
};
