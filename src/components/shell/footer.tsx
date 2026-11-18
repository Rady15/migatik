"use client";

import { useEffect, useState } from "react";
import { Clock, Heart } from "lucide-react";

export function Footer() {
  const [now, setNow] = useState<string>("");

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const pad = (x: number) => String(x).padStart(2, "0");
      setNow(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <footer className="border-t border-[#1B2946]/70 bg-[#0A1020] h-11 flex items-center justify-between px-5 text-[11px]">
      <div className="flex items-center gap-2 text-[#64748B]" dir="ltr">
        <span className="num">MikroTik Management System v1.0.0</span>
        <span className="text-[#33415580]">|</span>
        <span>Developed by Rady Khaled</span>
        <Heart className="w-3.5 h-3.5 text-[#EF4444] fill-[#EF4444]" />
      </div>
      <div className="flex items-center gap-2 text-[#8CA3C3]">
        <span className="dot dot-green" />
        <Clock className="w-3.5 h-3.5 text-[#7E93B4]" />
        <span className="font-bold text-[#CBD5E1]">الوقت والتاريخ:</span>
        <span className="num text-[#CBD5E1]" dir="ltr">{now}</span>
      </div>
    </footer>
  );
}
