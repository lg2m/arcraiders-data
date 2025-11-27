#!/usr/bin/env bash
set -euo pipefail

declare -A REPLACEMENTS=(
  ["equipment_bench"]="gear_bench"
  ["utility_bench"]="utility_station"
  ["explosives_bench"]="explosives_station"
  ["med_station"]="medical_lab"
  ["weapon_bench"]="gunsmith"
)

jq_expression="walk(
  if type == \"string\" then
    .
    $(for k in "${!REPLACEMENTS[@]}"; do
        printf ' | (if . == "%s" then "%s" else . end)' "$k" "${REPLACEMENTS[$k]}"
      done)
  else .
  end
)"

find ./data/items -type f -name "*.json" -print0 | while IFS= read -r -d '' file; do
  tmp="${file}.tmp"

  jq "$jq_expression" "$file" > "$tmp" && mv "$tmp" "$file"

  echo "Updated: $file"
done

echo "Done."
