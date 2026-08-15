"""
check_sites.py
ដំណើរការស្វ័យប្រវត្តិ៖ ផ្ញើ /bts [code] ទៅ Bot B ម្តងមួយៗតាមរយៈគណនី Telegram
ផ្ទាល់ខ្លួន (userbot) រួចកត់ត្រាលទ្ធផលទៅ Google Sheet តាមរយៈ Queue ក្នុង Sheet A។
"""

from datetime import datetime
import json
import os
import time

from google.oauth2.service_account import Credentials
import gspread
from telethon.sessions import StringSession
from telethon.sync import TelegramClient

# ============================================================
# CONFIG - តម្លៃភាគច្រើនមកពី GitHub Secrets (environment variables)
# ============================================================
API_ID = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
SESSION_STRING = os.environ["TELEGRAM_SESSION"]
BOT_USERNAME = os.environ[
    "BOT_USERNAME"
]  # ឈ្មោះ Bot B ដោយគ្មាន @ ឧ. "SomeStatusBot"
SPREADSHEET_ID = os.environ["SPREADSHEET_ID"]
GOOGLE_CREDS_JSON = os.environ[
    "GCP_SA_KEY"
]  # Service account JSON ទាំងមូល (គ្មាន encode)

CHECK_COMMAND = "/bts"
SHEET_QUEUE = "Queue"
SHEET_OFFLINE = "OfflineSites"
CHECKING_TEXT = (
    "Checking system"  # សារបណ្តោះអាសន្នពី Bot B មុននឹងឆ្លើយចម្លើយពិត - ត្រូវរំលងវាចោល
)
REPLY_TIMEOUT_SEC = (
    120  # រង់ចាំចម្លើយប៉ុន្មានវិនាទី (Bot B អាចយឺត ១-២ នាទី)
)
POLL_INTERVAL_SEC = 4  # ញែកមើលចម្លើយរៀងរាល់ប៉ុន្មានវិនាទី
DELAY_BETWEEN_SITES_SEC = (
    4  # ចន្លោះពេលរវាងសំណួរនីមួយៗ ដើម្បីជៀសវាងការរឹតត្បិតរបស់ Telegram
)


# ============================================================
# Google Sheets helpers
# ============================================================
def get_spreadsheet():
  creds_raw = GOOGLE_CREDS_JSON
  # ជួសជុលបញ្ហា private_key ពេលមាន \n ធានាថាមិន Error ហត្ថលេខា JWT
  try:
    creds_dict = json.loads(creds_raw)
  except json.JSONDecodeError:
    creds_dict = json.loads(creds_raw.encode().decode("unicode-escape"))

  if "private_key" in creds_dict:
    creds_dict["private_key"] = creds_dict["private_key"].replace(
        "\\n", "\n"
    )

  scopes = ["https://www.googleapis.com/auth/spreadsheets"]
  creds = Credentials.from_service_account_info(creds_dict, scopes=scopes)
  gc = gspread.authorize(creds)
  return gc.open_by_key(SPREADSHEET_ID)


def get_or_create_worksheet(sh, title, header):
  try:
    ws = sh.worksheet(title)
  except gspread.WorksheetNotFound:
    ws = sh.add_worksheet(title=title, rows=1000, cols=len(header))
    ws.append_row(header)
  return ws


def load_queue(sh):
  """អាន site code ពីជួរឈរ A របស់ Sheet 'Queue' (ជួរដេកទី 2 ចុះក្រោម)។"""
  ws = get_or_create_worksheet(
      sh, SHEET_QUEUE, ["Code", "Status", "Result", "CheckedAt"]
  )
  rows = ws.get_all_values()
  codes = []
  for row_num, row in enumerate(rows[1:], start=2):  # រំលងបន្ទាត់ header
    if row and row[0].strip():
      codes.append((row_num, row[0].strip()))
  return ws, codes


# ============================================================
# Telegram helpers
# ============================================================
def wait_for_reply(client, entity, sent_message):
  """ត្រួតពិនិត្យរកមើលសារថ្មីដែលចូលមកបន្ទាប់ពីសារយើងផ្ញើ (min_id) រហូតដល់ REPLY_TIMEOUT_SEC។

  រំលងសារបណ្តោះអាសន្ន "Checking system..." ចោល។
"""
  deadline = time.time() + REPLY_TIMEOUT_SEC
  while time.time() < deadline:
    for m in client.get_messages(entity, min_id=sent_message.id, limit=10):
      if m.out:
        continue  # សារយើងផ្ញើផ្ទាល់ - រំលង
      text = m.text or ""
      if CHECKING_TEXT in text:
        continue  # សារបណ្តោះអាសន្ន - នៅតែត្រូវរង់ចាំចម្លើយពិត
      return text
    time.sleep(POLL_INTERVAL_SEC)
  return None


# ============================================================
# Main
# ============================================================
def main():
  sh = get_spreadsheet()
  queue_ws, codes = load_queue(sh)
  offline_ws = get_or_create_worksheet(
      sh, SHEET_OFFLINE, ["Code", "CheckedAt"]
  )

  if not codes:
    print(
        "Queue sheet ទទេ - សូម paste site code ចូលជួរឈរ A សិន (ចាប់ពីជួរដេកទី"
        " 2)"
    )
    return

  online = offline = no_resp = 0

  with TelegramClient(StringSession(SESSION_STRING), API_ID, API_HASH) as client:
    entity = client.get_entity(BOT_USERNAME)

    for row_num, code in codes:
      sent = client.send_message(entity, f"{CHECK_COMMAND} {code}")

      reply_text = wait_for_reply(client, entity, sent)
      now = datetime.now().isoformat()

      if reply_text is None:
        result = "NoResponse"
        no_resp += 1
        offline_ws.append_row([code, now])
      elif "dc monitoring system disconnected" in reply_text.lower():
        result = "Offline"
        offline += 1
        offline_ws.append_row([code, now])
      else:
        # រាល់ករណីផ្សេងទៀត (រួមទាំង No data available) ចាត់ទុកជា Online
        result = "Online"
        online += 1

      queue_ws.update(f"B{row_num}:D{row_num}", [["Done", result, now]])
      print(f"{code}: {result}")

      time.sleep(DELAY_BETWEEN_SITES_SEC)

  print(f"\nរួចរាល់! Online={online}  Offline={offline}  NoResponse={no_resp}")


if __name__ == "__main__":
  main()
