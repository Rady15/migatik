"use client";

import { useApp } from "@/lib/store";
import { makeT } from "@/lib/i18n";

/** SVG illustrations matching the design's action cards */
function CardsIllustration() {
  return (
    <svg viewBox="0 0 120 92" className="w-full h-full" aria-hidden="true">
      {/* back card */}
      <rect x="14" y="26" width="78" height="50" rx="8" transform="rotate(-8 53 51)" fill="#0E2B55" stroke="#1D5FD6" strokeWidth="1.4" />
      {/* front card */}
      <g transform="rotate(6 70 46)">
        <rect x="34" y="18" width="82" height="52" rx="8" fill="#F4F8FF" stroke="#BFD6F5" strokeWidth="1" />
        <text x="40" y="34" fontSize="9" fontWeight="800" fill="#0B3B8C" fontFamily="Cairo, sans-serif">MikroTik</text>
        <text x="40" y="45" fontSize="6" fontWeight="700" fill="#33507E" fontFamily="Cairo, sans-serif">User Card</text>
        <text x="40" y="53" fontSize="5" fill="#6C86AC" fontFamily="Cairo, sans-serif">Access Card</text>
        {/* avatar */}
        <circle cx="47" cy="61" r="6" fill="#1D5FD6" opacity="0.85" />
        <circle cx="47" cy="59.6" r="2" fill="#F4F8FF" />
        <path d="M43.6 64.4 a4 4 0 0 1 6.8 0" fill="#F4F8FF" />
        {/* QR */}
        <g fill="#0F172A">
          <rect x="92" y="22" width="9" height="9" rx="1" fill="none" stroke="#0F172A" strokeWidth="1.2" />
          <rect x="94" y="24" width="5" height="5" />
          <rect x="103" y="22" width="9" height="9" rx="1" fill="none" stroke="#0F172A" strokeWidth="1.2" />
          <rect x="105" y="24" width="5" height="5" />
          <rect x="92" y="33" width="9" height="9" rx="1" fill="none" stroke="#0F172A" strokeWidth="1.2" />
          <rect x="94" y="35" width="5" height="5" />
          <rect x="103" y="33" width="4" height="4" />
          <rect x="108" y="36" width="4" height="4" />
          <rect x="103" y="44" width="4" height="4" />
        </g>
      </g>
      {/* wifi glow */}
      <circle cx="14" cy="76" r="10" fill="#1685FF" opacity="0.25" />
      <circle cx="14" cy="76" r="5" fill="#1685FF" opacity="0.5" />
    </svg>
  );
}

function PackageIllustration() {
  return (
    <svg viewBox="0 0 120 92" className="w-full h-full" aria-hidden="true">
      {/* box */}
      <path d="M32 30 L66 18 L98 30 L98 68 L66 82 L32 68 Z" fill="#C08A4E" />
      <path d="M32 30 L66 42 L98 30 L66 18 Z" fill="#D9A967" />
      <path d="M66 42 L66 82" stroke="#A9763C" strokeWidth="1.4" />
      <path d="M32 68 L66 82 L98 68" fill="none" stroke="#A9763C" strokeWidth="1.4" />
      {/* tape */}
      <path d="M58 22 L74 28 L74 40 L58 34 Z" fill="#EFE4D3" opacity="0.9" />
      {/* wifi badge */}
      <circle cx="52" cy="62" r="13" fill="#1685FF" />
      <path d="M46 60 a9 9 0 0 1 12 0 M48.5 63 a6 6 0 0 1 7 0" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      <circle cx="52" cy="66.5" r="1.6" fill="#fff" />
    </svg>
  );
}

function InvoiceIllustration() {
  return (
    <svg viewBox="0 0 120 92" className="w-full h-full" aria-hidden="true">
      <g transform="rotate(4 62 46)">
        <rect x="30" y="10" width="60" height="74" rx="5" fill="#F6F9FF" stroke="#C3D6F2" strokeWidth="1" />
        <rect x="36" y="18" width="30" height="10" rx="2" fill="#0B3B8C" />
        <text x="51" y="25.5" fontSize="6.5" fontWeight="800" fill="#fff" textAnchor="middle" fontFamily="Arial, sans-serif">INVOICE</text>
        <g stroke="#B9CBE4" strokeWidth="2.4" strokeLinecap="round">
          <path d="M37 36 h40" /><path d="M37 43 h46" /><path d="M37 50 h34" /><path d="M37 57 h44" /><path d="M37 64 h28" />
        </g>
        <circle cx="76" cy="70" r="10" fill="#10B981" />
        <text x="76" y="74.5" fontSize="12" fontWeight="800" fill="#fff" textAnchor="middle" fontFamily="Arial, sans-serif">$</text>
      </g>
    </svg>
  );
}

export function ActionCards() {
  const setView = useApp((s) => s.setView);
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);

  // RTL DOM order = rightmost first, matching the design (right→left):
  // إدارة الفواتير (green) · إدارة الباقات (purple) · طباعة الكروت (blue)
  const cards = [
    {
      key: "invoices",
      title: t("invoicesMgmt"),
      desc: t("createInvoices"),
      btn: t("createInvoice"),
      btnClass: "bg-gradient-to-l from-[#0FA36B] to-[#087A4E] hover:from-[#12BE80] hover:to-[#0A8F5C]",
      illo: <InvoiceIllustration />,
      go: () => setView("payments"),
    },
    {
      key: "packages",
      title: t("managePackages"),
      desc: t("createManagePackages"),
      btn: t("managePackages"),
      btnClass: "bg-gradient-to-l from-[#5B3FD6] to-[#3B2A8C] hover:from-[#6C50E6] hover:to-[#4936A6]",
      illo: <PackageIllustration />,
      go: () => setView("packages"),
    },
    {
      key: "cards",
      title: t("printCards"),
      desc: t("createPrintCards"),
      btn: t("printCards"),
      btnClass: "bg-gradient-to-l from-[#2E82FF] to-[#0F55C4] hover:from-[#4A94FF] hover:to-[#1D6FE0]",
      illo: <CardsIllustration />,
      go: () => setView("cards"),
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
      {cards.map((c) => (
        <div key={c.key} className="panel p-4 flex items-center gap-3 min-h-[132px]">
          <div className="flex-1 min-w-0">
            <div className="text-white font-extrabold text-[15px] mb-1">{c.title}</div>
            <div className="text-[#8CA3C3] text-[11px] mb-3 leading-relaxed">{c.desc}</div>
            <button
              onClick={c.go}
              className={`text-white text-[12px] font-bold rounded-lg px-4 py-2 transition-all shadow-lg ${c.btnClass}`}
            >
              {c.btn}
            </button>
          </div>
          <div className="w-[110px] h-[92px] shrink-0">{c.illo}</div>
        </div>
      ))}
    </div>
  );
}
