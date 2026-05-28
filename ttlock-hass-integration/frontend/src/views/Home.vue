<template>
  <v-container fluid class="fill-height px-4 py-8">
    <!-- Empty state when no locks are found -->
    <v-row v-if="locks.length === 0" align="center" justify="center" class="mt-8">
      <v-col cols="12" sm="8" md="6" lg="5">
        <v-card class="elevation-4 rounded-lg overflow-hidden pa-6 text-center border-top-blue">
          <v-card-text class="pt-8">
            <div class="avatar-container mb-6">
              <v-icon size="90" color="blue lighten-1" class="pulse-icon">mdi-bluetooth-connect</v-icon>
            </div>
            
            <h2 class="display-1 font-weight-bold mb-4 grey--text text--darken-3">Add Your TTLock</h2>
            <p class="body-1 text--secondary mb-6 leading-relaxed">
              Pair and operate your smart locks locally. To get started, make sure your Bluetooth adapter is configured and wake up your lock's keypad so it starts broadcasting.
            </p>

            <v-divider class="my-6"></v-divider>

            <h3 class="subtitle-1 font-weight-bold mb-3 text-left grey--text text--darken-2">
              <v-icon small left color="blue">mdi-alert-circle-outline</v-icon> Setup Steps:
            </h3>
            <ul class="text-left body-2 text--secondary pl-5 mb-8 spacing-y">
              <li>Ensure your USB Bluetooth dongle is plugged into your HA device.</li>
              <li>Configure the correct adapter (e.g. <code>hci0</code>) in the Add-on Configuration tab.</li>
              <li><strong>Wake up the lock:</strong> Press any key on your lock's keypad to light it up.</li>
              <li>Click the button below to scan and pair your lock.</li>
            </ul>
          </v-card-text>

          <v-card-actions class="justify-center pb-8">
            <v-btn
              v-if="!isScanning"
              color="blue darken-1"
              dark
              x-large
              rounded
              class="px-8 font-weight-bold shadow-premium"
              v-on:click="startScan"
            >
              <v-icon left>mdi-magnify</v-icon>
              Scan for Locks
            </v-btn>
            <div v-else class="text-center">
              <v-progress-circular indeterminate color="blue" size="50" width="5" class="mb-4"></v-progress-circular>
              <div class="body-1 blue--text font-weight-medium animate-pulse">Scanning nearby BLE devices...</div>
            </div>
          </v-card-actions>
        </v-card>
      </v-col>
    </v-row>

    <!-- Locks grid when found -->
    <v-row v-else no-gutters>
      <v-col v-for="lock in locks" :key="lock.address" lg="3" md="4" sm="12" class="pa-2">
        <Lock :lock="lock" />
      </v-col>
    </v-row>
  </v-container>
</template>

<script>
import Lock from "@/components/Lock";

export default {
  name: "Home",
  components: {
    Lock,
  },
  computed: {
    locks() {
      return this.$store.state.locks;
    },
    isScanning() {
      return this.$store.state.scanStatus === 1;
    },
  },
  methods: {
    startScan() {
      this.$store.dispatch("scan");
    },
  },
};
</script>

<style scoped>
.border-top-blue {
  border-top: 5px solid #1e88e5 !important;
}
.avatar-container {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 140px;
  height: 140px;
  background-color: #e3f2fd;
  border-radius: 50%;
}
.pulse-icon {
  animation: pulse 2s infinite;
}
.shadow-premium {
  box-shadow: 0 4px 14px 0 rgba(30, 136, 229, 0.4) !important;
}
.leading-relaxed {
  line-height: 1.6;
}
.spacing-y li {
  margin-bottom: 8px;
}
.animate-pulse {
  animation: text-pulse 1.5s infinite;
}

@keyframes pulse {
  0% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 rgba(30, 136, 229, 0.4);
  }
  70% {
    transform: scale(1);
    box-shadow: 0 0 0 15px rgba(30, 136, 229, 0);
  }
  100% {
    transform: scale(0.95);
    box-shadow: 0 0 0 0 rgba(30, 136, 229, 0);
  }
}

@keyframes text-pulse {
  0% {
    opacity: 0.6;
  }
  50% {
    opacity: 1;
  }
  100% {
    opacity: 0.6;
  }
}
</style>
