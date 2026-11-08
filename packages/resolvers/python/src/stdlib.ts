/**
 * Top-level standard-library module names for CPython 3.9–3.13 (union of
 * sys.stdlib_module_names). Static list; CodeMap never runs Python to discover it.
 */
export const PYTHON_STDLIB: ReadonlySet<string> = new Set(
  `__future__ _thread abc aifc argparse array ast asynchat asyncio asyncore atexit audioop base64 bdb binascii bisect
builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections colorsys compileall concurrent
configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm decimal difflib dis
distutils doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib
functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr
imp importlib inspect io ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal
math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib nt ntpath nturl2path numbers opcode
operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath
pprint profile pstats pty pwd py_compile pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource
rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver
spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau symtable
sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios textwrap this threading time timeit tkinter token tokenize
tomllib trace traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings
wave weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo _abc _ast
_asyncio _bisect _collections _collections_abc _csv _datetime _decimal _functools _heapq _io _json _locale _operator
_pickle _random _socket _sqlite3 _ssl _stat _string _struct _thread _threading_local _warnings _weakref _weakrefset`
    .split(/\s+/)
    .filter(Boolean),
);

/** Common distribution-name → import-name differences. */
export const DISTRIBUTION_IMPORT_ALIASES: Readonly<Record<string, string[]>> = {
  pyyaml: ["yaml"],
  beautifulsoup4: ["bs4"],
  pillow: ["PIL"],
  "scikit-learn": ["sklearn"],
  "opencv-python": ["cv2"],
  "opencv-python-headless": ["cv2"],
  "python-dateutil": ["dateutil"],
  "python-dotenv": ["dotenv"],
  pyjwt: ["jwt"],
  attrs: ["attr", "attrs"],
  "protobuf": ["google"],
  "google-cloud-storage": ["google"],
  "typing-extensions": ["typing_extensions"],
  "msgpack-python": ["msgpack"],
  pymysql: ["pymysql"],
  "psycopg2-binary": ["psycopg2"],
  "python-multipart": ["multipart"],
};
