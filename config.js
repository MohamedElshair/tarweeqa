/*
  إعدادات ترويقة
  ---------------
  طول ما firebase = null البرنامج بيشتغل "نسخة تجريبية" على جهازك بس (البيانات مش بتتشارك).
  عشان الناس كلها تشوف نفس السلة، الصق هنا إعدادات Firebase (الخطوات في دليل التشغيل).

  Tarweeqa settings
  -----------------
  While firebase is null the app runs in DEMO mode (data stays on this device only).
  Paste your Firebase web config below to share carts between people.
*/
window.TARWEEQA_CONFIG = {
  // قاعدة البيانات (Supabase) — the live database. The key below is the public one; the database functions protect the data.
  supabase: {
    url: "https://vbylwccpccveazthdpmq.supabase.co",
    anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZieWx3Y2NwY2N2ZWF6dGhkcG1xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU2MjkyNDcsImV4cCI6MjExMTIwNTI0N30.hqpzwdA0m81nICRBHCKYqcvr8PEMapI2IGwS_3-Ia7o"
  },
  firebase: null,

  // مثال — Example (replace the line above with something like this):
  // firebase: {
  //   apiKey: "AIza....",
  //   authDomain: "tarweeqa-xxxx.firebaseapp.com",
  //   projectId: "tarweeqa-xxxx",
  //   storageBucket: "tarweeqa-xxxx.firebasestorage.app",
  //   messagingSenderId: "1234567890",
  //   appId: "1:1234567890:web:abc123"
  // },

  // خرائط جوجل — Google Maps key (Maps JavaScript API + Places API (New)). Empty = the map search is off.
  // Admins use it to verify a restaurant's place and to find restaurants near the delivery point.
  googleMapsKey: "",
  // أقصى مسافة توصيل افتراضية للمطعم (كم) — default delivery range per restaurant, editable per restaurant
  defaultDeliveryKm: 3,

  firebaseSdkVersion: "12.19.0",
  currency: { ar: "ج.م", en: "EGP" },
  defaultCountryCode: "20",
  defaultCartMinutes: 30,
  reminderMinutesBeforeClose: 15,
  ocrPath: "ocr/"
};
