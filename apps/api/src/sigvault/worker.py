import asyncio
import json
import signal

import structlog

from . import jobs, queue
from .config import settings

log = structlog.get_logger()


async def run() -> None:
    assert settings.worker_mode, "worker.py must not run in API mode"
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for s in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(s, stop.set)

    log.info("worker_started")
    while not stop.is_set():
        msgs = await asyncio.to_thread(queue.receive, 20, 1)
        for m in msgs:
            try:
                await jobs.process(json.loads(m["Body"]))
                await asyncio.to_thread(queue.delete, m["ReceiptHandle"])
            except Exception:
                log.exception("job_processing_failed", message_id=m["MessageId"])
            if stop.is_set():
                break
    log.info("worker_drained_and_exiting")


if __name__ == "__main__":
    asyncio.run(run())
