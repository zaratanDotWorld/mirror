const { db } = require('./db');

const { truncateHour } = require('../utils');

// Houses

exports.addHouse = async function (slackId, name) {
  return db('House')
    .insert({ slackId, name })
    .onConflict('slackId').ignore();
};

exports.getHouse = async function (slackId) {
  return db('House')
    .where({ slackId })
    .select('*')
    .first();
};

exports.getHouses = async function () {
  return db('House')
    .select('slackId');
};

exports.updateHouseConf = async function (slackId, confName, conf) {
  // NOTE: May be possible as a single operation using a jsonb datatype
  const house = await exports.getHouse(slackId);
  conf = { ...house[confName], ...conf };

  return db('House')
    .where({ slackId })
    .update(confName, conf)
    .returning('*');
};

exports.houseActive = async function (houseId, table, field, startTime, endTime) {
  // TODO: use count(*) and handle BigInt correctly
  const obj = await db(table)
    .where({ houseId })
    .whereBetween(field, [ startTime, endTime ])
    .select('id');

  return obj.length > 0;
};

// Residents

exports.activateResident = async function (houseId, slackId, now) {
  // No-op if already active
  const resident = await exports.getResident(slackId);
  if (resident && resident.activeAt) { return; }

  const activeAt = truncateHour(now);

  return db('Resident')
    .insert({ houseId, slackId, activeAt, exemptAt: null })
    .onConflict('slackId').merge();
};

exports.deactivateResident = async function (houseId, slackId) {
  return db('Resident')
    .insert({ houseId, slackId, activeAt: null })
    .onConflict('slackId').merge();
};

exports.getResidents = async function (houseId, now) {
  return db('Resident')
    .where({ houseId })
    .where('activeAt', '<=', now)
    .select('*');
};

exports.getResident = async function (residentId) {
  return db('Resident')
    .where({ slackId: residentId })
    .select('*')
    .first();
};

exports.isActive = async function (residentId, now) {
  const resident = await exports.getResident(residentId);
  return (resident && resident.activeAt && resident.activeAt <= now);
};
