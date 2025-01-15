exports.up = function(knex, Promise) {
    return knex.schema.createTable('Resident', function(t) {
        t.increments('id').unsigned().primary();
        t.timestamps(useTimestamps = true, defaultToNow = true, useCamelCase = true);
        t.string('slackId').unique().notNull(); // Slack-generated userId, workspace-specific
        t.string('houseId').references('House.slackId').notNull();
        t.timestamp('activeAt');
        t.timestamp('exemptAt'); // NOTE: deprecated
    });
};

exports.down = function(knex, Promise) {
    return knex.schema.dropTable('Resident');
};
