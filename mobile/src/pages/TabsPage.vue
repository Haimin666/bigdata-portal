<template>
  <ion-tabs>
    <ion-router-outlet />
    <ion-tab-bar slot="bottom">
      <ion-tab-button tab="home" href="/app/home"><ion-icon :icon="gridOutline" /><ion-label>总览</ion-label></ion-tab-button>
      <ion-tab-button tab="yarn" href="/app/yarn"><ion-icon :icon="pulseOutline" /><ion-label>YARN</ion-label></ion-tab-button>
      <ion-tab-button tab="offline" href="/app/offline"><ion-icon :icon="gitNetworkOutline" /><ion-label>离线开发</ion-label></ion-tab-button>
      <ion-tab-button tab="profile" href="/app/profile"><ion-icon :icon="personCircleOutline" /><ion-label>我的</ion-label></ion-tab-button>
    </ion-tab-bar>
  </ion-tabs>
</template>

<script setup lang="ts">
import { IonIcon, IonLabel, IonRouterOutlet, IonTabBar, IonTabButton, IonTabs } from '@ionic/vue'
import { gitNetworkOutline, gridOutline, personCircleOutline, pulseOutline } from 'ionicons/icons'
</script>
