const { expect } = require('chai');
const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');

chai.use(chaiAsPromised);

const { Hearts, Polls, Admin } = require('../src/core/index');
const { NAY, YAY, HOUR, DAY, HEART_UNKNOWN, HEART_KARMA, HEART_CHALLENGE, HEART_REVIVE } = require('../src/constants');
const { heartsPollLength, heartsBaselineAmount, heartsReviveAmount, heartsMaxBase, karmaDelay } = require('../src/config');
const { getNextMonthStart } = require('../src/utils');
const testHelpers = require('./helpers');

describe('Hearts', async () => {
  const HOUSE = testHelpers.generateSlackId();
  const RESIDENT1 = testHelpers.generateSlackId();
  const RESIDENT2 = testHelpers.generateSlackId();
  const RESIDENT3 = testHelpers.generateSlackId();
  const RESIDENT4 = testHelpers.generateSlackId();
  const RESIDENT5 = testHelpers.generateSlackId();
  const RESIDENT6 = testHelpers.generateSlackId();

  let now;
  let soon;
  let tomorrow;
  let challengeEnd;
  let nextMonth;
  let twoMonths;

  beforeEach(async () => {
    now = new Date();
    soon = new Date(now.getTime() + HOUR);
    tomorrow = new Date(now.getTime() + DAY);
    challengeEnd = new Date(now.getTime() + heartsPollLength);
    nextMonth = getNextMonthStart(now);
    twoMonths = getNextMonthStart(nextMonth);

    await Admin.addHouse(HOUSE);
    await Admin.activateResident(HOUSE, RESIDENT1, now);
    await Admin.activateResident(HOUSE, RESIDENT2, now);
    await Admin.activateResident(HOUSE, RESIDENT3, now);
    await Admin.activateResident(HOUSE, RESIDENT4, now);
    await Admin.activateResident(HOUSE, RESIDENT5, now);
  });

  afterEach(async () => {
    await testHelpers.resetDb();
  });

  describe('using hearts', async () => {
    it('can generate hearts for residents', async () => {
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 1);
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 1);
      await Hearts.generateHearts(HOUSE, RESIDENT2, HEART_UNKNOWN, now, 1);

      const hearts1 = await Hearts.getHearts(RESIDENT1, now);
      const hearts2 = await Hearts.getHearts(RESIDENT2, now);
      const hearts3 = await Hearts.getHearts(RESIDENT3, now);

      expect(hearts1).to.equal(2);
      expect(hearts2).to.equal(1);
      expect(hearts3).to.equal(null);
    });

    it('can query for specific hearts', async () => {
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_CHALLENGE, now, 1);
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_KARMA, now, 2);

      const heart = await Hearts.getHeart(RESIDENT1, now);
      expect(heart.value).to.equal(1);
      expect(heart.type).to.equal(HEART_CHALLENGE);
    });

    it('can get hearts for the house at once', async () => {
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 2);
      await Hearts.generateHearts(HOUSE, RESIDENT2, HEART_UNKNOWN, now, 1);

      const hearts = await Hearts.getHouseHearts(HOUSE, now);
      expect(hearts.length).to.equal(2);
      expect(hearts[0].sum).to.equal(2);
      expect(hearts[1].sum).to.equal(1);
    });

    it('can exclude inactive users from the hearts list', async () => {
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 2);
      await Hearts.generateHearts(HOUSE, RESIDENT2, HEART_UNKNOWN, now, 1);

      let hearts;
      hearts = await Hearts.getHouseHearts(HOUSE, now);
      expect(hearts.length).to.equal(2);

      await Admin.deactivateResident(HOUSE, RESIDENT2);

      hearts = await Hearts.getHouseHearts(HOUSE, now);
      expect(hearts.length).to.equal(1);
    });

    it('can aggregate positive and negative hearts', async () => {
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 2);
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 1);
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, -2);

      const hearts = await Hearts.getHearts(RESIDENT1, now);

      expect(hearts).to.equal(1);
    });

    it('can handle fractional hearts', async () => {
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 2.5);
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, -0.75);

      const hearts = await Hearts.getHearts(RESIDENT1, now);

      expect(hearts).to.equal(1.75);
    });

    it('can initialise a resident', async () => {
      await Hearts.initialiseResident(HOUSE, RESIDENT1, now);

      let hearts;
      hearts = await Hearts.getHearts(RESIDENT1, now);
      expect(hearts).to.equal(heartsBaselineAmount);

      // But only once
      await Hearts.initialiseResident(HOUSE, RESIDENT1, now);

      hearts = await Hearts.getHearts(RESIDENT1, now);
      expect(hearts).to.equal(heartsBaselineAmount);

      // Even if they go back to zero
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, -heartsBaselineAmount);

      await Hearts.initialiseResident(HOUSE, RESIDENT1, now);

      hearts = await Hearts.getHearts(RESIDENT1, now);
      expect(hearts).to.equal(0);
    });

    it('can revive a resident', async () => {
      await Hearts.initialiseResident(HOUSE, RESIDENT1, now);

      let heart;
      let hearts;

      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, -heartsBaselineAmount);

      // Will revive at 0 hearts
      [ heart ] = await Hearts.reviveResidents(HOUSE, now);
      expect(heart.type).to.equal(HEART_REVIVE);

      hearts = await Hearts.getHearts(RESIDENT1, now);
      expect(hearts).to.equal(heartsReviveAmount);

      // But not twice
      [ heart ] = await Hearts.reviveResidents(HOUSE, now);
      expect(heart).to.be.undefined;

      hearts = await Hearts.getHearts(RESIDENT1, now);
      expect(hearts).to.equal(heartsReviveAmount);
    });

    it('can check if a house is active using hearts', async () => {
      const nextWeek = new Date(now.getTime() + 7 * DAY);

      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 1);

      let active;
      active = await Admin.houseActive(HOUSE, 'Heart', 'generatedAt', now, tomorrow);
      expect(active).to.be.true;

      active = await Admin.houseActive(HOUSE, 'Heart', 'generatedAt', tomorrow, nextWeek);
      expect(active).to.be.false;
    });

    it('can use hearts to scale required votes', async () => {
      let voteScalar;

      // Return 1 if not initialised
      voteScalar = await Hearts.getHeartsVoteScalar(RESIDENT1, now);
      expect(voteScalar).to.equal(1);

      // 0 hearts
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 0);
      voteScalar = await Hearts.getHeartsVoteScalar(RESIDENT1, now);
      expect(voteScalar).to.equal(2);

      // 3 hearts
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 3);
      voteScalar = await Hearts.getHeartsVoteScalar(RESIDENT1, now);
      expect(voteScalar).to.equal(1.4);

      // Return 5 hearts
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 2);
      voteScalar = await Hearts.getHeartsVoteScalar(RESIDENT1, now);
      expect(voteScalar).to.equal(1);

      // 7 hearts
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 2);
      voteScalar = await Hearts.getHeartsVoteScalar(RESIDENT1, now);
      expect(voteScalar).to.equal(0.6);

      // 10 hearts
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 3);
      voteScalar = await Hearts.getHeartsVoteScalar(RESIDENT1, now);
      expect(voteScalar).to.equal(0);
    });
  });

  describe('regenerating hearts', async () => {
    it('can calculate the regen amount', async () => {
      expect(Hearts.getRegenAmount(1.0)).to.almost.equal(0.25);
      expect(Hearts.getRegenAmount(4.9)).to.almost.equal(0.1);
      expect(Hearts.getRegenAmount(5.0)).to.almost.equal(0.0);
      expect(Hearts.getRegenAmount(5.1)).to.almost.equal(-0.1);
      expect(Hearts.getRegenAmount(7.0)).to.almost.equal(-0.25);
    });

    it('can regenerate hearts', async () => {
      let hearts;

      // Won't regenerate if not initialised
      await Hearts.regenerateHearts(HOUSE, RESIDENT1, nextMonth);

      hearts = await Hearts.getHearts(RESIDENT1, nextMonth);
      expect(hearts).to.equal(null);

      // Generate a heart, now regeneration works
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 1);

      await Hearts.regenerateHearts(HOUSE, RESIDENT1, nextMonth);

      hearts = await Hearts.getHearts(RESIDENT1, nextMonth);
      expect(hearts).to.equal(1.25);

      // But not in the same month
      await Hearts.regenerateHearts(HOUSE, RESIDENT1, nextMonth);

      hearts = await Hearts.getHearts(RESIDENT1, nextMonth);
      expect(hearts).to.equal(1.25);

      // But yes in another month
      await Hearts.regenerateHearts(HOUSE, RESIDENT1, twoMonths);

      hearts = await Hearts.getHearts(RESIDENT1, twoMonths);
      expect(hearts).to.equal(1.5);
    });

    it('cannot regenerate hearts if full', async () => {
      let hearts;

      await Hearts.initialiseResident(HOUSE, RESIDENT1, now);

      hearts = await Hearts.getHearts(RESIDENT1, now);
      expect(hearts).to.equal(5);

      await Hearts.regenerateHearts(HOUSE, RESIDENT1, now);

      hearts = await Hearts.getHearts(RESIDENT1, now);
      expect(hearts).to.equal(5);

      // Or overloaded
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, nextMonth, 1);

      hearts = await Hearts.getHearts(RESIDENT1, nextMonth);
      expect(hearts).to.equal(6);

      await Hearts.regenerateHearts(HOUSE, RESIDENT1, nextMonth);

      hearts = await Hearts.getHearts(RESIDENT1, nextMonth);
      expect(hearts).to.equal(6);
    });

    it('can regenerate hearts in bulk', async () => {
      await Hearts.generateHearts(HOUSE, RESIDENT1, HEART_UNKNOWN, now, 1);
      await Hearts.generateHearts(HOUSE, RESIDENT2, HEART_UNKNOWN, now, 7);

      let hearts;
      hearts = await Hearts.regenerateHouseHearts(HOUSE, nextMonth);
      expect(hearts.length).to.equal(2);
      expect(hearts.find(x => x.residentId === RESIDENT1).value).to.equal(0.25);
      expect(hearts.find(x => x.residentId === RESIDENT2).value).to.equal(-0.25);

      // Bulk regeneration is robust to network failures
      await Hearts.generateHearts(HOUSE, RESIDENT3, HEART_UNKNOWN, now, 3);

      hearts = await Hearts.regenerateHouseHearts(HOUSE, nextMonth);
      expect(hearts.length).to.equal(1);
      expect(hearts[0].value).to.equal(0.25);
    });
  });

  describe('making challenges', async () => {
    beforeEach(async () => {
      await Hearts.initialiseResident(HOUSE, RESIDENT1, now);
      await Hearts.initialiseResident(HOUSE, RESIDENT2, now);
      await Hearts.initialiseResident(HOUSE, RESIDENT3, now);
    });

    it('can issue a challenge', async () => {
      const [ challenge ] = await Hearts.issueChallenge(HOUSE, RESIDENT1, RESIDENT2, 2, now, 'Rude behavior');
      expect(challenge.challengerId).to.equal(RESIDENT1);
      expect(challenge.challengeeId).to.equal(RESIDENT2);
      expect(challenge.value).to.equal(2);
      expect(challenge.metadata.circumstance).to.equal('Rude behavior');
    });

    it('can resolve a challenge where the challenger wins', async () => {
      const [ challenge ] = await Hearts.issueChallenge(HOUSE, RESIDENT1, RESIDENT2, 1, now, '');

      await Polls.submitVote(challenge.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(challenge.pollId, RESIDENT2, now, NAY);
      await Polls.submitVote(challenge.pollId, RESIDENT3, now, YAY);
      await Polls.submitVote(challenge.pollId, RESIDENT4, now, YAY);
      await Polls.submitVote(challenge.pollId, RESIDENT5, now, YAY);

      await Hearts.resolveChallenge(challenge.id, challengeEnd);

      const hearts1 = await Hearts.getHearts(RESIDENT1, challengeEnd);
      const hearts2 = await Hearts.getHearts(RESIDENT2, challengeEnd);
      expect(hearts1).to.equal(5);
      expect(hearts2).to.equal(4);
    });

    it('can resolve a challenge where the challenger loses', async () => {
      const [ challenge ] = await Hearts.issueChallenge(HOUSE, RESIDENT1, RESIDENT2, 1, now, '');

      await Polls.submitVote(challenge.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(challenge.pollId, RESIDENT2, now, NAY);
      await Polls.submitVote(challenge.pollId, RESIDENT3, now, NAY);

      await Hearts.resolveChallenge(challenge.id, challengeEnd);

      const hearts1 = await Hearts.getHearts(RESIDENT1, challengeEnd);
      const hearts2 = await Hearts.getHearts(RESIDENT2, challengeEnd);
      expect(hearts1).to.equal(4);
      expect(hearts2).to.equal(5);
    });

    it('can resolve a challenge where minVotes is not reached', async () => {
      const [ challenge ] = await Hearts.issueChallenge(HOUSE, RESIDENT1, RESIDENT2, 1, now, '');

      // Quorum is 2, only 1 vote is submitted
      await Polls.submitVote(challenge.pollId, RESIDENT1, now, YAY);

      await Hearts.resolveChallenge(challenge.id, challengeEnd);

      const hearts1 = await Hearts.getHearts(RESIDENT1, challengeEnd);
      const hearts2 = await Hearts.getHearts(RESIDENT2, challengeEnd);
      expect(hearts1).to.equal(4);
      expect(hearts2).to.equal(5);
    });

    it('can resolve challenges in bulk', async () => {
      const [ challenge ] = await Hearts.issueChallenge(HOUSE, RESIDENT1, RESIDENT2, 1, now, '');
      await Hearts.issueChallenge(HOUSE, RESIDENT3, RESIDENT1, 2, now, '');
      await Hearts.issueChallenge(HOUSE, RESIDENT2, RESIDENT3, 3, soon, '');

      await Polls.submitVote(challenge.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(challenge.pollId, RESIDENT3, now, YAY);
      await Polls.submitVote(challenge.pollId, RESIDENT4, now, YAY);
      await Polls.submitVote(challenge.pollId, RESIDENT5, now, YAY);

      // Challenger 1 wins, challenger 2 loses, challenge 3 is not yet resolved
      await Hearts.resolveChallenges(HOUSE, challengeEnd);

      const hearts1 = await Hearts.getHearts(RESIDENT1, challengeEnd);
      const hearts2 = await Hearts.getHearts(RESIDENT2, challengeEnd);
      const hearts3 = await Hearts.getHearts(RESIDENT3, challengeEnd);
      expect(hearts1).to.equal(5);
      expect(hearts2).to.equal(4);
      expect(hearts3).to.equal(3);
    });

    it('cannot resolve a challenge before the poll is closed', async () => {
      const [ challenge ] = await Hearts.issueChallenge(HOUSE, RESIDENT1, RESIDENT2, 1, now, '');

      await Polls.submitVote(challenge.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(challenge.pollId, RESIDENT2, now, NAY);
      await Polls.submitVote(challenge.pollId, RESIDENT3, now, YAY);

      await expect(Hearts.resolveChallenge(challenge.id, soon))
        .to.be.rejectedWith('Poll not closed!');
    });

    it('cannot resolve a challenge twice', async () => {
      const [ challenge ] = await Hearts.issueChallenge(HOUSE, RESIDENT1, RESIDENT2, 1, now, '');

      await Polls.submitVote(challenge.pollId, RESIDENT1, now, YAY);
      await Polls.submitVote(challenge.pollId, RESIDENT2, now, NAY);
      await Polls.submitVote(challenge.pollId, RESIDENT3, now, YAY);

      await Hearts.resolveChallenge(challenge.id, challengeEnd);

      await expect(Hearts.resolveChallenge(challenge.id, challengeEnd))
        .to.be.rejectedWith('Challenge already resolved!');
    });

    it('can get the minimum votes for a challenge', async () => {
      let minVotes;

      // Challenge reducing to 3 hearts, needs 40% of 5 residents = 2
      minVotes = await Hearts.getChallengeMinVotes(HOUSE, RESIDENT2, 2, now);
      expect(minVotes).to.equal(2);

      // Challenge reducing to 1 hearts, needs 70% of 5 residents = 4
      minVotes = await Hearts.getChallengeMinVotes(HOUSE, RESIDENT2, 4, now);
      expect(minVotes).to.equal(4);
    });

    it('cannot challenge oneself', async () => {
      const dbError = 'insert into "HeartChallenge" ' +
        '("challengedAt", "challengeeId", "challengerId", "houseId", "metadata", "pollId", "value") ' +
        'values ($1, $2, $3, $4, $5, $6, $7) returning * ' +
        '- new row for relation "HeartChallenge" violates check constraint "HeartChallenge_check';

      await expect(Hearts.issueChallenge(HOUSE, RESIDENT1, RESIDENT1, 1, now, ''))
        .to.be.rejectedWith(dbError);
    });

    it('cannot issue a challenge if one already exists for the challengee', async () => {
      const [ challenge ] = await Hearts.issueChallenge(HOUSE, RESIDENT1, RESIDENT2, 2, now, 'Rude behavior');

      await expect(Hearts.issueChallenge(HOUSE, RESIDENT1, RESIDENT2, 2, now, 'Ruder behavior'))
        .to.be.rejectedWith('Active challenge exists!');

      // Challenger can challenge again
      await Hearts.issueChallenge(HOUSE, RESIDENT1, RESIDENT3, 2, now, 'Rudest behavior');

      await Hearts.resolveChallenge(challenge.id, challengeEnd);

      // But now you can
      await Hearts.issueChallenge(HOUSE, RESIDENT1, RESIDENT2, 2, now, 'Ruder behavior');
    });
  });

  describe('using karma', async () => {
    let nextMonthKarma;
    let twoMonthsKarma;

    beforeEach(async () => {
      await Admin.activateResident(HOUSE, RESIDENT6, now);

      await Hearts.initialiseResident(HOUSE, RESIDENT1, now);
      await Hearts.initialiseResident(HOUSE, RESIDENT2, now);
      await Hearts.initialiseResident(HOUSE, RESIDENT3, now);
      await Hearts.initialiseResident(HOUSE, RESIDENT4, now);
      await Hearts.initialiseResident(HOUSE, RESIDENT5, now);
      await Hearts.initialiseResident(HOUSE, RESIDENT6, now);

      nextMonthKarma = new Date(nextMonth.getTime() + karmaDelay);
      twoMonthsKarma = new Date(twoMonths.getTime() + karmaDelay);
    });

    it('can extract recipients from a message', async () => {
      const message = `Thanks <@${RESIDENT1}>++ and <@${RESIDENT2}> ++ for dinner!`;
      const recipients = Hearts.getKarmaRecipients(message);

      expect(recipients.length).to.equal(2);
      expect(recipients[0]).to.equal(RESIDENT1);
      expect(recipients[1]).to.equal(RESIDENT2);
    });

    it('can give karma to a resident', async () => {
      await Hearts.giveKarma(HOUSE, RESIDENT1, RESIDENT2, now);
      await Hearts.giveKarma(HOUSE, RESIDENT2, RESIDENT3, now);

      const karma = await Hearts.getKarma(HOUSE, now, challengeEnd);
      expect(karma.length).to.equal(2);
    });

    it('cannot give karma to oneself', async () => {
      const dbError = 'insert into "HeartKarma" ("givenAt", "giverId", "houseId", "receiverId") values ($1, $2, $3, $4) returning * - ' +
        'new row for relation "HeartKarma" violates check constraint "HeartKarma_check"';

      await expect(Hearts.giveKarma(HOUSE, RESIDENT1, RESIDENT1, now))
        .to.be.rejectedWith(dbError);
    });

    it('can calculate ranks based on karma', async () => {
      await Hearts.giveKarma(HOUSE, RESIDENT1, RESIDENT2, now);
      await Hearts.giveKarma(HOUSE, RESIDENT1, RESIDENT3, now);
      await Hearts.giveKarma(HOUSE, RESIDENT2, RESIDENT3, now);

      const rankings = await Hearts.getKarmaRankings(HOUSE, now, challengeEnd);
      expect(rankings[0].slackId).to.equal(RESIDENT3);
      expect(rankings[0].ranking).to.equal(7.5);
      expect(rankings[1].slackId).to.equal(RESIDENT2);
      expect(rankings[1].ranking).to.equal(2.5);
    });

    it('cannot game the rankings by issuing a lot of karma', async () => {
      await Hearts.giveKarma(HOUSE, RESIDENT1, RESIDENT2, now);
      await Hearts.giveKarma(HOUSE, RESIDENT1, RESIDENT2, now);
      await Hearts.giveKarma(HOUSE, RESIDENT1, RESIDENT2, now);

      const rankings = await Hearts.getKarmaRankings(HOUSE, now, challengeEnd);
      expect(rankings[0].slackId).to.equal(RESIDENT2);
      expect(rankings[0].ranking).to.equal(5);
    });

    it('can get the number of karma winners based on house size', async () => {
      const house = testHelpers.generateSlackId();
      const r1 = testHelpers.generateSlackId();
      const r2 = testHelpers.generateSlackId();
      const r3 = testHelpers.generateSlackId();
      const r4 = testHelpers.generateSlackId();
      const r5 = testHelpers.generateSlackId();
      const r6 = testHelpers.generateSlackId();

      await Admin.addHouse(house);

      let numWinners;

      await Admin.activateResident(house, r1, now);
      await Admin.activateResident(house, r2, now);
      await Hearts.initialiseResident(house, r1, now);
      await Hearts.initialiseResident(house, r2, now);
      // Create two unique recipients
      await Hearts.giveKarma(house, r1, r2, now);
      await Hearts.giveKarma(house, r2, r1, now);
      // Two residents, no karma hearts
      numWinners = await Hearts.getNumKarmaWinners(house, now, soon);
      expect(numWinners).to.equal(0);

      await Admin.activateResident(house, r3, now);
      await Admin.activateResident(house, r4, now);
      await Admin.activateResident(house, r5, now);
      await Hearts.initialiseResident(house, r3, now);
      await Hearts.initialiseResident(house, r4, now);
      await Hearts.initialiseResident(house, r5, now);
      // Five residents, one karma heart
      numWinners = await Hearts.getNumKarmaWinners(house, now, soon);
      expect(numWinners).to.equal(1);

      await Admin.activateResident(house, r6, now);
      await Hearts.initialiseResident(house, r6, now);
      // Six residents, two karma hearts
      numWinners = await Hearts.getNumKarmaWinners(house, now, soon);
      expect(numWinners).to.equal(2);
    });

    it('can get the number of karma winners based on number of recipients', async () => {
      let numWinners;

      numWinners = await Hearts.getNumKarmaWinners(HOUSE, now, soon);
      expect(numWinners).to.equal(0);

      await Hearts.giveKarma(HOUSE, RESIDENT1, RESIDENT2, now);
      numWinners = await Hearts.getNumKarmaWinners(HOUSE, now, soon);
      expect(numWinners).to.equal(1);

      // If r2 receives again, no increase in karma hearts
      await Hearts.giveKarma(HOUSE, RESIDENT3, RESIDENT2, now);
      numWinners = await Hearts.getNumKarmaWinners(HOUSE, now, soon);
      expect(numWinners).to.equal(1);

      // New unique recipient, increase in karma hearts
      await Hearts.giveKarma(HOUSE, RESIDENT4, RESIDENT5, now);
      numWinners = await Hearts.getNumKarmaWinners(HOUSE, now, soon);
      expect(numWinners).to.equal(2);
    });

    it('can generate karma hearts', async () => {
      let karmaHearts;

      // Will do nothing if numWinners is 0
      karmaHearts = await Hearts.generateKarmaHearts(HOUSE, nextMonthKarma);
      expect(karmaHearts.length).to.equal(0);

      await Hearts.giveKarma(HOUSE, RESIDENT1, RESIDENT2, now);

      // Now we give a karma heart
      karmaHearts = await Hearts.generateKarmaHearts(HOUSE, nextMonthKarma);
      expect(karmaHearts.length).to.equal(1);
      expect(karmaHearts[0].residentId).to.equal(RESIDENT2);
      expect(karmaHearts[0].value).to.equal(1);
      expect(karmaHearts[0].type).to.equal(HEART_KARMA);
      expect(karmaHearts[0].metadata.ranking).to.equal(5);

      // But not twice
      karmaHearts = await Hearts.generateKarmaHearts(HOUSE, nextMonthKarma);
      expect(karmaHearts.length).to.equal(0);

      // If they're at the limit, they get less
      const numToGenerate = (heartsMaxBase - heartsBaselineAmount) - 0.5;
      await Hearts.generateHearts(HOUSE, RESIDENT4, HEART_UNKNOWN, nextMonthKarma, numToGenerate);
      await Hearts.giveKarma(HOUSE, RESIDENT1, RESIDENT4, nextMonthKarma);

      karmaHearts = await Hearts.generateKarmaHearts(HOUSE, twoMonthsKarma);
      expect(karmaHearts.length).to.equal(1);
      expect(karmaHearts[0].residentId).to.equal(RESIDENT4);
      expect(karmaHearts[0].value).to.equal(0.5);
    });

    it('can generate multiple karma hearts', async () => {
      await Hearts.giveKarma(HOUSE, RESIDENT1, RESIDENT2, now);
      await Hearts.giveKarma(HOUSE, RESIDENT1, RESIDENT3, now);
      await Hearts.giveKarma(HOUSE, RESIDENT2, RESIDENT3, now);

      // R3 > R2 > R1
      const karmaHearts = await Hearts.generateKarmaHearts(HOUSE, nextMonthKarma);
      expect(karmaHearts.length).to.equal(2);
      expect(karmaHearts[0].residentId).to.equal(RESIDENT3);
      expect(karmaHearts[1].residentId).to.equal(RESIDENT2);
    });

    it('can increase maximum hearts by earning karma', async () => {
      // Value of the hearts does not matter
      const karmaHeart = { houseId: HOUSE, residentId: RESIDENT1, type: HEART_KARMA, generatedAt: now, value: 0 };

      let maxHearts;
      maxHearts = await Hearts.getResidentMaxHearts(RESIDENT1, now);
      expect(maxHearts).to.equal(7);

      await Hearts.insertKarmaHearts([ karmaHeart ]);
      await Hearts.insertKarmaHearts([ karmaHeart ]);
      await Hearts.insertKarmaHearts([ karmaHeart ]);

      maxHearts = await Hearts.getResidentMaxHearts(RESIDENT1, now);
      expect(maxHearts).to.equal(7);

      await Hearts.insertKarmaHearts([ karmaHeart ]);

      maxHearts = await Hearts.getResidentMaxHearts(RESIDENT1, now);
      expect(maxHearts).to.equal(8);

      for (let i = 0; i < 8; i++) {
        await Hearts.insertKarmaHearts([ karmaHeart ]);
      }

      maxHearts = await Hearts.getResidentMaxHearts(RESIDENT1, now);
      expect(maxHearts).to.equal(10);

      for (let i = 0; i < 4; i++) {
        await Hearts.insertKarmaHearts([ karmaHeart ]);
      }

      maxHearts = await Hearts.getResidentMaxHearts(RESIDENT1, now);
      expect(maxHearts).to.equal(10);
    });
  });
});
