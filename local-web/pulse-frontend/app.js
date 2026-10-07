// Pulse Modular Application Script (v1.3.0)
(function() {
  const parts = [
    "js/part_01.js",
    "js/part_02.js",
    "js/part_03.js",
    "js/part_04.js",
    "js/part_05.js",
    "js/part_06.js",
    "js/part_07.js",
    "js/part_08.js",
    "js/part_09.js",
    "js/part_10.js",
    "js/part_11.js",
    "js/part_12.js",
    "js/part_13.js",
    "js/part_14.js",
    "js/part_15.js",
    "js/part_16.js",
    "js/part_17.js",
    "js/part_18.js",
    "js/part_19.js",
    "js/part_20.js",
    "js/part_21.js",
  ];
  for (const part of parts) {
    const s = document.createElement("script");
    s.src = part;
    s.async = false;
    document.head.appendChild(s);
  }
})();
