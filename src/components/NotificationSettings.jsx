import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Bell, AlertTriangle, HelpCircle, CheckCircle2, Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { base44 } from '@/api/base44Client';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');
  
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export default function NotificationSettings() {
  const [permission, setPermission] = useState('Checking...');
  const [isStandalone, setIsStandalone] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSendingTest, setIsSendingTest] = useState(false);

  useEffect(() => {
    setIsStandalone(window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone);
    if ('Notification' in window) {
      setPermission(Notification.permission);
    } else {
      setPermission('Unsupported');
    }
    checkSubscription();
  }, []);

  const checkSubscription = async () => {
    if (!('serviceWorker' in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      setIsSubscribed(!!subscription);
    } catch (err) {
      console.error('Error checking subscription:', err);
    }
  };

  const subscribeToPush = async () => {
    setIsLoading(true);
    try {
      const result = await enablePush();
      if (result === "on") { setIsSubscribed(true); setPermission("granted"); toast.success(pushResultMessage.on); }
      else { if (result === "denied") setPermission(Notification.permission); toast.error(pushResultMessage[result]); }
    } catch (e) {
      console.error('Subscription error:', e);
      toast.error('Could not turn on notifications. On iPhone, add the app to your Home Screen first.');
    } finally {
      setIsLoading(false);
    }
  };

  const unsubscribeFromPush = async () => {
    setIsLoading(true);
    try {
      await disablePush();
      setIsSubscribed(false);
      toast.success('Notifications are off for this device.');
    } catch (e) {
      toast.error('Could not turn off notifications.');
    } finally {
      setIsLoading(false);
    }
  };

  const sendTestNotification = async () => {
    setIsSendingTest(true);
    try {
      const res = await base44.functions.invoke('webPush', { action: 'test' });
      if (res.data?.success) toast.success('Test sent. It should appear in a few seconds.');
      else toast.error(res.data?.error || 'Could not send a test notification.');
    } catch (e) {
      toast.error('Could not send a test notification.');
    } finally {
      setIsSendingTest(false);
    }
  };

  return (
    <Card className="glass-card rounded-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Bell className="w-5 h-5 text-primary" />
          Web Push Notifications
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-foreground">
        <div className="flex items-center justify-between p-4 rounded-xl border border-border bg-secondary">
          <div>
            <p className="font-medium text-foreground">Browser Permission</p>
            <p className="text-xs text-muted-foreground mt-1">Allows the app to display push notifications.</p>
          </div>
          {permission === 'granted' ? (
            <span className="flex items-center gap-1 text-primary font-medium px-3 py-1 bg-primary/10 rounded-full border border-primary/20">
              <CheckCircle2 className="w-4 h-4" /> Granted
            </span>
          ) : permission === 'denied' ? (
            <span className="flex items-center gap-1 text-red-400 font-medium px-3 py-1 bg-red-500/10 rounded-full border border-red-500/20">
              <AlertTriangle className="w-4 h-4" /> Denied
            </span>
          ) : (
            <span className="flex items-center gap-1 text-primary font-medium px-3 py-1 bg-primary/10 rounded-full border border-primary/20 capitalize">
              <HelpCircle className="w-4 h-4" /> {permission}
            </span>
          )}
        </div>

        <div className="p-4 bg-primary/10 border border-primary/20 rounded-xl space-y-2">
          <h4 className="font-semibold text-primary flex items-center gap-2">
            <Bell className="w-4 h-4" />
            Native Web Push Enabled
          </h4>
          <p className="text-muted-foreground">
            This app supports native web push notifications using the standard Web Push API. 
            Works on Android, Desktop, and iOS 16.4+ (when added to Home Screen).
          </p>
          {!isStandalone && (
            <p className="text-primary font-medium text-xs mt-2 bg-primary/30 p-2 rounded flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>Note: You are currently running in browser mode. Full push support on iOS requires adding the app to your Home Screen first.</span>
            </p>
          )}
        </div>

        <div className="space-y-3 pt-2">
          <h4 className="font-semibold text-foreground">Device Subscription</h4>
          <p className="text-muted-foreground">Subscribe this device to receive instant alerts when your trainer assigns a workout or sends a message.</p>
          
          {isSubscribed ? (
            <div className="space-y-3">
              <Button 
                variant="outline" 
                onClick={unsubscribeFromPush}
                disabled={isLoading}
                className="w-full bg-red-500/10 hover:bg-red-500/20 text-red-400 border-red-500/20"
              >
                {isLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Unsubscribe Device
              </Button>
              <Button 
                variant="default" 
                onClick={sendTestNotification}
                disabled={isSendingTest}
                className="w-full"
              >
                {isSendingTest ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                Send Test Notification
              </Button>
            </div>
          ) : (
            <Button 
              variant="default" 
              onClick={subscribeToPush}
              disabled={isLoading || permission === 'denied'}
              className="w-full"
            >
              {isLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Bell className="w-4 h-4 mr-2" />}
              {permission === 'denied' ? 'Notifications Blocked in Settings' : 'Subscribe to Notifications'}
            </Button>
          )}
        </div>

        <div className="pt-4 border-t border-border space-y-3">
          <h4 className="font-semibold text-foreground">Troubleshooting</h4>
          <div className="space-y-2 text-xs text-muted-foreground bg-card p-3 rounded-lg border border-border">
            <p>• <strong>Not receiving notifications?</strong> Make sure notifications are allowed for this site in your browser/device settings.</p>
            <p>• <strong>iOS Users:</strong> You MUST tap "Share" &gt; "Add to Home Screen", then open the app from your home screen to enable push notifications.</p>
            <p>• <strong>Multiple Devices:</strong> You need to enable notifications on each device separately.</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}