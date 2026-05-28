'use strict';

// Catch errors from noble
process.on('uncaughtException', (error, promise) => {
  console.error('uncaughtException catch:', promise);
  console.error(error);
  const manager = require("./src/manager");
  manager.startupStatus = 1;
});

const init = require("./src/init");
init({
 // options go here
  settingsPath: process.env.DATA_PATH || "/data",
  mqttHost: process.env.MQTT_HOST,
  mqttPort: process.env.MQTT_PORT,
  mqttSSL: process.env.MQTT_SSL,
  mqttUser: process.env.MQTT_USER,
  mqttPass: process.env.MQTT_PASS,
  gateway: "none"
});
