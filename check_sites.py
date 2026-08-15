"""
check_sites.py
ដំណើរការស្វ័យប្រវត្តិ៖ ផ្ញើ /bts CHA0001 ... CHA0500 ទៅ Bot B ម្តងមួយៗតាមរយៈគណនី Telegram
ផ្ទាល់ខ្លួន (userbot) រួចកត់ត្រាលទ្ធផលទៅ Google Sheet។ រត់ដោយ GitHub Actions តាមកាលវិភាគ។
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
GCP_SA_KEY = os.environ["GCP_SA_KEY"]  # Service account JSON string

SITE_PREFIX = "CHA"
SITE_DIGITS = 4
SITE_COUNT = 500
CHECK_COMMAND = "/bts"
NO_DATA_TEXT = "No data available"
REPLY_TIMEOUT_SEC = 20  # រង់ចាំចម្លើយប៉ុន្មានវិនាទីមុននឹងចាត់ទុកថាគ្មានចម្លើយ
POLL_INTERVAL_SEC = 2  # ញែកមើលចម្លើយរៀងរាល់ប៉ុន្មានវិនាទី
DELAY_BETWEEN_SITES_SEC = (
    4  # ចន្លោះពេលរវាងសំណួរនីមួយៗ ដើម្បីជៀសវាងការរឹតត្បិតរបស់ Telegram
)


# ============================================================
# Google Sheets helpers
# ============================================================
def get_spreadsheet():
  creds_raw = os.environ["GCP_SA_KEY"]
  # ដោះស្រាយបញ្ហា private_key ពេលមាន \n
  creds_dict = json.loads(creds_raw)
  if "private_key" in creds_dict:
    creds_dict["private_key"] = creds_dict["private_key"].replace("\\n", "\n")

  scopes = ["https://www.googleapis.com/auth/spreadsheets"]
  creds = Credentials.from_service_account_info(creds_dict, scopes=scopes)
  gc = gspread.authorize(creds)
  return gc.open_by_key(SPREADSHEET_ID)


def get_or_create_worksheet(sh, title, header):
  try:
    ws = sh.worksheet(title)
  except gspread.WorksheetNotFound:
    ws = sh.add_worksheet(title=title, rows=SITE_COUNT + 10, cols=len(header))
    ws.append_row(header)
  return ws


# ============================================================
# Telegram helpers
# ============================================================
def wait_for_reply(client, entity, sent_message):
  """ត្រួតពិនិត្យរកមើលចម្លើយ (reply) ត្រង់ទៅសារដែលបានផ្ញើ រហូតដល់ REPLY_TIMEOUT_SEC"""
  deadline = time.time() + REPLY_TIMEOUT_SEC
  while time.time() < deadline:
    for m in client.get_messages(entity, limit=5):
      if m.reply_to and m.reply_to.reply_to_msg_id == sent_message.id:
        return m.text or ""
    time.sleep(POLL_INTERVAL_SEC)
  return None


# ============================================================
# Main
# ============================================================
def main():
  sh = get_spreadsheet()
  queue_ws = get_or_create_worksheet(
      sh, "Queue", ["Index", "Code", "Status", "Result", "CheckedAt"]
  )
  offline_ws = get_or_create_worksheet(sh, "OfflineSites", ["Code", "CheckedAt"])

  online = offline = no_resp = 0
  queue_rows = []

  with TelegramClient(StringSession(SESSION_STRING), API_ID, API_HASH) as client:
    entity = client.get_entity(BOT_USERNAME)

    for i in range(1, SITE_COUNT + 1):
      code = f"{SITE_PREFIX}{i:0{SITE_DIGITS}d}"
      sent = client.send_message(entity, f"{CHECK_COMMAND} {code}")

      reply_text = wait_for_reply(client, entity, sent)
      now = datetime.now().isoformat()

      if reply_text is None:
        result = "NoResponse"
        no_resp += 1
        offline_ws.append_row([code, now])
      elif NO_DATA_TEXT in reply_text:
        result = "Offline"
        offline += 1
        offline_ws.append_row([code, now])
      else:
        result = "Online"
        online += 1

      queue_rows.append([i, code, "Done", result, now])
      print(f"{code}: {result}")

      time.sleep(DELAY_BETWEEN_SITES_SEC)

  # សរសេរចូល Sheet ម្តងជាបាច់ធំ (លឿនជាង និងសន្សំសំចៃ API calls)
  queue_ws.append_rows(queue_rows)

  print(f"\nរួចរាល់! Online={online}  Offline={offline}  NoResponse={no_resp}")


if __name__ == "__main__":
  main()
