"use client";

import { useState } from "react";
import { useApp } from "@/lib/store";
import { makeT } from "@/lib/i18n";
import { fmtNum } from "@/lib/store";
import { WORLD_MAP_PATH, WORLD_MAP_VIEWBOX } from "@/lib/world-map-data";
import { Plus, Minus } from "lucide-react";

/** city dots: [lon, lat, countryCode, countryNameAr] */
const CITIES: [number, number, string, string][] = [
  [31.24, 30.04, "EG", "مصر"],
  [46.7, 24.7, "SA", "السعودية"],
  [55.3, 25.2, "AE", "الإمارات"],
  [44.4, 33.3, "IQ", "العراق"],
  [35.9, 32.0, "JO", "الأردن"],
  [13.2, 32.9, "LY", "ليبيا"],
  [32.5, 15.5, "SD", "السودان"],
  [-7.6, 33.6, "MA", "المغرب"],
  [3.1, 36.8, "DZ", "الجزائر"],
  [44.2, 15.4, "YE", "اليمن"],
  [36.3, 33.5, "SY", "سوريا"],
  [47.9, 29.4, "KW", "الكويت"],
  [-99.1, 19.4, "MX", "المكسيك"],
  [-74.0, 40.7, "US", "الولايات المتحدة"],
  [-118.2, 34.0, "US", "الولايات المتحدة"],
  [-46.6, -23.5, "BR", "البرازيل"],
  [-0.1, 51.5, "GB", "المملكة المتحدة"],
  [2.35, 48.85, "FR", "فرنسا"],
  [13.4, 52.5, "DE", "ألمانيا"],
  [37.6, 55.75, "RU", "روسيا"],
  [3.4, 6.5, "NG", "نيجيريا"],
  [28.0, -26.2, "ZA", "جنوب أفريقيا"],
  [72.9, 19.1, "IN", "الهند"],
  [77.2, 28.6, "IN", "الهند"],
  [103.8, 1.35, "SG", "سنغافورة"],
  [106.8, -6.2, "ID", "إندونيسيا"],
  [139.7, 35.7, "JP", "اليابان"],
  [151.2, -33.9, "AU", "أستراليا"],
];

function project(lon: number, lat: number): [number, number] {
  const x = ((lon + 180) / 360) * 1000;
  const y = ((78 - lat) / 140) * 470;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}

export function WorldMap({ mapUsers }: { mapUsers: Record<string, number> }) {
  const lang = useApp((s) => s.lang);
  const t = makeT(lang);
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<string | null>(null);

  const zooms = [1, 1.5, 2.2, 3.2];
  const zi = Math.min(zooms.indexOf(zoom) >= 0 ? zooms.indexOf(zoom) : 0, zooms.length - 1);
  const z = zooms[zi];
  const vw = 1000 / z;
  const vh = 470 / z;
  const cx = 500 - vw / 2;
  const cy = 235 - vh / 2;

  const egCount = mapUsers["EG"] ?? 0;
  const pinned = hover ?? "EG";
  const pinnedCity = CITIES.find((c) => c[2] === pinned);
  const pinnedPos = pinnedCity ? project(pinnedCity[0], pinnedCity[1]) : null;
  const pinnedName = pinnedCity ? pinnedCity[3] : "مصر";
  const pinnedUsers = mapUsers[pinned] ?? 0;

  return (
    <div className="panel p-4 h-full min-h-[250px] flex flex-col">
      <div className="text-center panel-title text-white">{t("userLocations")}</div>
      <div className="relative flex-1 min-h-[170px] overflow-hidden rounded-lg" dir="ltr">
        <svg
          viewBox={`${cx} ${cy} ${vw} ${vh}`}
          className="w-full h-full transition-all duration-300"
          preserveAspectRatio="xMidYMid slice"
        >
          <defs>
            <radialGradient id="dotGlow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.9" />
              <stop offset="55%" stopColor="#1685FF" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#1685FF" stopOpacity="0" />
            </radialGradient>
          </defs>
          <path d={WORLD_MAP_PATH} fill="#223351" stroke="#2E4166" strokeWidth="0.4" />
          {CITIES.map(([lon, lat, code], idx) => {
            const [x, y] = project(lon, lat);
            const count = mapUsers[code] ?? 0;
            if (count === 0 && code !== "EG") return null;
            const size = count > 1000 ? 16 : count > 300 ? 12 : count > 100 ? 9 : 6;
            return (
              <g key={idx}>
                <circle cx={x} cy={y} r={size * 1.6} fill="url(#dotGlow)" opacity={0.85} />
                <circle
                  cx={x}
                  cy={y}
                  r={size / 2.4}
                  fill="#4FC3F7"
                  className="map-dot-pulse"
                  style={{ transformBox: "fill-box", transformOrigin: "center" }}
                />
                <circle cx={x} cy={y} r={size / 4} fill="#E0F2FE" />
                <circle
                  cx={x}
                  cy={y}
                  r={size / 1.6}
                  fill="transparent"
                  className="cursor-pointer"
                  onMouseEnter={() => setHover(code)}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            );
          })}
        </svg>

        {/* tooltip — pinned on Egypt by default like the design */}
        {pinnedPos && (
          <div
            className="absolute z-10 bg-[#0B1428]/95 border border-[#24344F] rounded-lg px-3 py-1.5 pointer-events-none shadow-xl"
            style={{
              left: `${(pinnedPos[0] / 1000) * 100}%`,
              top: `${(pinnedPos[1] / 470) * 100}%`,
              transform: "translate(-50%, 12%)",
            }}
          >
            <div className="text-[11px] font-bold text-white">{pinnedName}</div>
            <div className="text-[10px] text-[#8CA3C3] num">
              {fmtNum(pinnedUsers)} {t("usersLabel")}
            </div>
          </div>
        )}

        {/* zoom controls */}
        <div className="absolute bottom-2 end-2 flex flex-col gap-1.5 z-10" dir="ltr">
          <button
            onClick={() => setZoom(zooms[Math.min(zi + 1, zooms.length - 1)])}
            className="w-7 h-7 rounded-md bg-[#17243B] border border-[#2E4166] flex items-center justify-center text-[#CBD5E1] hover:bg-[#223351]"
            aria-label="zoom in"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setZoom(zooms[Math.max(zi - 1, 0)])}
            className="w-7 h-7 rounded-md bg-[#17243B] border border-[#2E4166] flex items-center justify-center text-[#CBD5E1] hover:bg-[#223351]"
            aria-label="zoom out"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
