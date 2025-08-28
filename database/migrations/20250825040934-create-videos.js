'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('yt_dl', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      iplog: {
        type: Sequelize.STRING,
        allowNull: false
      },
      url: {
        type: Sequelize.STRING,
        allowNull: false
      },
      resolution: {
        type: Sequelize.STRING,
        allowNull: false
      },
      format: {
        type: Sequelize.ENUM('mp4', 'mp3', 'm4a', 'webm', 'mkv'),
        allowNull: false
      },
      filename: {
        type: Sequelize.STRING,
        allowNull: false
      },
      filesize: {
        type: Sequelize.STRING,
        allowNull: false
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('yt_dl');
  }
};