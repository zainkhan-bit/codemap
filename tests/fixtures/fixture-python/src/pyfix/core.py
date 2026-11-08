import os
import requests
import yaml
from .util import helper
from . import util
from .base import Base


class Engine(Base):
    def __init__(self):
        self.ready = False

    def run(self):
        self.step()
        helper()
        util.helper()
        return os.getcwd()

    def step(self):
        pass
